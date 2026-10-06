import { z } from 'zod';
import { seq, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { escapeLike, optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import { vehicleLabel } from '@/server/vehicles/service';
import type { BusinessContext } from '@/server/context';
import { splitCreditNote } from './calc';
import { dateOnly, lineInputSchema, loadFinanceSettings, lockRow, nextDocumentNumber, priceLines, recordFinanceEvent, staffActor, totalsOf, type LineData } from './common';
import { generateOrQueue } from '@/server/documents/generator';
import { addCreditEntry, recomputeInvoice } from './ledger';
import { sendFinanceMessage } from './notify';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const creditNoteCreateSchema = z.object({
  invoiceId: uuidSchema,
  reason: z.string().trim().min(3, 'Give a reason').max(300),
  notes: optionalText(1000),
  /** 'full' copies every line of the invoice (a full reversal); otherwise list the lines to credit. */
  copy: z.enum(['full']).optional(),
  lines: z.array(lineInputSchema).max(200).optional(),
});

type CreditNoteRow = Awaited<ReturnType<Tx['creditNote']['findFirstOrThrow']>>;

async function loadCreditNote(tx: Tx, ctx: BusinessContext, id: string): Promise<CreditNoteRow> {
  const scope = await visibleLocationIds(tx, ctx);
  const cn = await tx.creditNote.findFirst({ where: { id, businessId: ctx.business.id, invoice: locationWhere(scope) } });
  if (!cn) throw Errors.notFound('Credit note');
  return cn;
}

/**
 * Draft a credit note against an issued invoice. It uses the invoice's own tax facts, can never credit more than the invoice
 * was for (counting other credit notes), and changes nothing until someone with authority issues it. The original invoice is
 * never edited: this is the controlled way to correct it.
 */
export async function createCreditNote(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'credit_note.create');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(creditNoteCreateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const scope = await visibleLocationIds(tx, ctx);
    const inv = await tx.invoice.findFirst({ where: { id: d.invoiceId, businessId, ...locationWhere(scope) }, include: { lines: { orderBy: { position: 'asc' } } } });
    if (!inv) throw Errors.notFound('Invoice');
    if (!inv.finalisedAt) throw Errors.conflict('A draft invoice can simply be edited; credit notes are for issued invoices.');
    if (inv.cancelledAt) throw Errors.conflict('This invoice is cancelled.');
    if (inv.writtenOffAt) throw Errors.conflict('This invoice has been written off.');

    let lines: LineData[];
    if (d.copy === 'full') {
      lines = inv.lines.map((l) => ({
        lineType: l.lineType, description: l.description, sku: l.sku ?? undefined, unit: l.unit ?? undefined, quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents,
        discountType: l.discountType, discountValue: l.discountValue, taxTreatment: l.taxTreatment, unitCostCents: l.unitCostCents,
      }));
    } else {
      if (!d.lines?.length) throw Errors.validation({ lines: 'Add at least one line to credit.' });
      lines = d.lines.map((l) => ({ ...l, unitCostCents: undefined }));
    }
    const tax = { vatRegistered: inv.vatRegistered, vatRateBps: inv.vatRateBps, pricesIncludeVat: inv.pricesIncludeVat };
    // A full reversal reverses the invoice's own document discount too, so the credit equals the invoice total exactly.
    const discount = d.copy === 'full' ? { type: inv.discountType, value: inv.discountValue } : { type: 'NONE' as const, value: 0 };
    const { calc, rows } = priceLines(lines, tax, discount);
    if (calc.totalCents <= 0) throw Errors.validation({ lines: 'A credit note must be for more than zero.' });

    const others = await tx.creditNote.aggregate({ where: { businessId, invoiceId: inv.id, status: { not: 'CANCELLED' } }, _sum: { totalCents: true } });
    const room = inv.totalCents - (others._sum.totalCents ?? 0);
    if (calc.totalCents > room) throw Errors.conflict(`Credit notes against this invoice cannot add up to more than its total. At most ${formatMoney(Math.max(0, room), ctx.business.currency, ctx.business.locale)} can still be credited.`, { maxCents: Math.max(0, room) });

    const cn = await tx.creditNote.create({
      data: {
        businessId, invoiceId: inv.id, customerId: inv.customerId, vehicleId: inv.vehicleId, status: 'DRAFT', reason: d.reason, notes: d.notes ?? null,
        vatRegistered: tax.vatRegistered, vatRateBps: tax.vatRateBps, pricesIncludeVat: tax.pricesIncludeVat, ...totalsOf(calc), createdById: ctx.user.id,
      },
    });
    // Credit note lines carry no links to jobs, parts or labour (only to the credit note itself).
    await tx.creditNoteLine.createMany({
      data: rows.map(({ inventoryItemId: _i, jobPartId: _p, jobLabourId: _l, recommendedWorkId: _w, technicianMembershipId: _t, minutes: _m, ...r }) => {
        void _i; void _p; void _l; void _w; void _t; void _m;
        return { ...r, businessId, creditNoteId: cn.id };
      }),
    });
    await recordFinanceEvent(tx, businessId, { entityType: 'credit_note', entityId: cn.id, type: 'credit_note.created', actor: staffActor(ctx), meta: ctx.meta, detail: { invoiceId: inv.id, totalCents: calc.totalCents } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.creditNoteCreated, businessId, userId: ctx.user.id, resourceType: 'credit_note', resourceId: cn.id, metadata: { invoiceId: inv.id, invoiceNumber: inv.number, totalCents: calc.totalCents, reason: d.reason } });
    return { id: cn.id, totalCents: calc.totalCents };
  });
}

/**
 * Authorise (issue) a credit note: allocates its number, reduces what the invoice still owes, and puts any excess on the
 * customer's credit. Everything happens in one transaction under the customer and invoice locks. Issuing twice is a no-op.
 */
export async function issueCreditNote(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'credit_note.authorise');
  assertCanWrite(ctx.subscription);
  const cnId = parseOrThrow(uuidSchema, id);
  const out = await withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const first = await loadCreditNote(tx, ctx, cnId);
    await lockRow(tx, 'customers', businessId, first.customerId);
    await lockRow(tx, 'invoices', businessId, first.invoiceId);
    await lockRow(tx, 'credit_notes', businessId, cnId);
    const cn = await tx.creditNote.findFirstOrThrow({ where: { id: cnId, businessId } });
    if (cn.status === 'ISSUED') return { id: cnId, number: cn.number!, appliedCents: cn.appliedCents, creditedCents: cn.creditedCents, already: true };
    if (cn.status !== 'DRAFT') throw Errors.conflict('This credit note was cancelled.');
    const inv0 = await tx.invoice.findFirstOrThrow({ where: { id: cn.invoiceId, businessId } });
    if (inv0.cancelledAt || inv0.writtenOffAt) throw Errors.conflict('This invoice is cancelled or written off, so it cannot be credited.');
    const issued = await tx.creditNote.aggregate({ where: { businessId, invoiceId: cn.invoiceId, status: 'ISSUED' }, _sum: { totalCents: true } });
    if ((issued._sum.totalCents ?? 0) + cn.totalCents > inv0.totalCents) throw Errors.conflict('Issued credit notes would add up to more than the invoice total.');

    const inv = await recomputeInvoice(tx, businessId, cn.invoiceId);
    const { applied, credited } = splitCreditNote(cn.totalCents, inv.outstandingCents);
    const settings = await loadFinanceSettings(tx, businessId);
    const number = await nextDocumentNumber(tx, businessId, 'credit_note', settings, inv.locationId);
    const now = new Date();
    await tx.creditNote.update({ where: { id: cnId }, data: { status: 'ISSUED', number, issuedAt: now, authorisedById: ctx.user.id, appliedCents: applied, creditedCents: credited } });
    if (credited > 0) {
      await addCreditEntry(tx, businessId, { customerId: cn.customerId, kind: 'CREDIT_NOTE', amountCents: credited, invoiceId: cn.invoiceId, creditNoteId: cnId, note: `Credit note ${number}`, idempotencyKey: `cn:${cnId}:credit`, createdById: ctx.user.id });
    }
    const after = await recomputeInvoice(tx, businessId, cn.invoiceId);
    await recordFinanceEvent(tx, businessId, { entityType: 'credit_note', entityId: cnId, type: 'credit_note.issued', actor: staffActor(ctx), meta: ctx.meta, detail: { number, appliedCents: applied, creditedCents: credited } });
    await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: cn.invoiceId, type: 'invoice.credit_note_issued', actor: staffActor(ctx), meta: ctx.meta, detail: { creditNote: number, totalCents: cn.totalCents } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.creditNoteIssued, businessId, userId: ctx.user.id, resourceType: 'credit_note', resourceId: cnId, metadata: { number, invoiceId: cn.invoiceId, invoiceNumber: inv.number, totalCents: cn.totalCents, appliedCents: applied, creditedCents: credited, createdById: cn.createdById } });
    if (credited > 0) await recordAudit(tx, ctx.meta, { action: AuditActions.customerCreditAdded, businessId, userId: ctx.user.id, resourceType: 'customer', resourceId: cn.customerId, metadata: { creditNoteId: cnId, amountCents: credited, kind: 'CREDIT_NOTE' } });
    await recordActivity(tx, businessId, ctx.user.id, { type: 'credit_note.issued', summary: `Credit note ${number} issued against invoice ${inv.number}`, customerId: cn.customerId, vehicleId: cn.vehicleId, jobId: inv.jobId, data: { creditNoteId: cnId } });
    await sendFinanceMessage(tx, businessId, {
      customerId: cn.customerId, entityType: 'credit_note', entityId: cnId, event: 'CREDIT_NOTE_ISSUED', vehicleId: cn.vehicleId, dedupeKey: `credit_note:${cnId}:issued`,
      vars: { credit_note_number: number, invoice_number: inv.number ?? '', credit_note_total: formatMoney(cn.totalCents, ctx.business.currency, ctx.business.locale) },
    });
    return { id: cnId, number, appliedCents: applied, creditedCents: credited, already: false, invoiceStatus: after.status, invoiceOutstandingCents: after.outstandingCents };
  });
  if (!out.already) {
    await generateOrQueue(ctx.business.id, ctx.user.id, 'credit_note', cnId, { dedupeKey: `credit_note:${cnId}:issued` });
    // The invoice's own record now shows the credit: keep a new stored version of it (a controlled, event-driven version).
    const cnRow = await withTenant(ctx.business.id, (tx) => tx.creditNote.findFirst({ where: { id: cnId, businessId: ctx.business.id }, select: { invoiceId: true } })).catch(() => null);
    if (cnRow) await generateOrQueue(ctx.business.id, ctx.user.id, 'invoice', cnRow.invoiceId, { dedupeKey: `invoice:${cnRow.invoiceId}:credit:${cnId}`, regenerate: true, reason: 'Credit note issued' });
  }
  return out;
}

export const creditNoteCancelSchema = z.object({ reason: optionalText(300) });

/** Cancel a DRAFT credit note (an issued one is final). */
export async function cancelCreditNote(ctx: BusinessContext, id: string, input: unknown = {}) {
  requirePermission(ctx, 'credit_note.create');
  assertCanWrite(ctx.subscription);
  const cnId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(creditNoteCancelSchema, input ?? {});
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    await loadCreditNote(tx, ctx, cnId);
    await lockRow(tx, 'credit_notes', businessId, cnId);
    const cn = await tx.creditNote.findFirstOrThrow({ where: { id: cnId, businessId } });
    if (cn.status === 'CANCELLED') return { id: cnId, status: 'CANCELLED' as const };
    if (cn.status !== 'DRAFT') throw Errors.conflict('An issued credit note cannot be cancelled.');
    await tx.creditNote.update({ where: { id: cnId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await recordFinanceEvent(tx, businessId, { entityType: 'credit_note', entityId: cnId, type: 'credit_note.cancelled', actor: staffActor(ctx), meta: ctx.meta, detail: { reason: d.reason } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.creditNoteCancelled, businessId, userId: ctx.user.id, resourceType: 'credit_note', resourceId: cnId, metadata: { reason: d.reason } });
    return { id: cnId, status: 'CANCELLED' as const };
  });
}

export const creditNoteListSchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'CANCELLED']).optional(),
  customerId: uuidSchema.optional(),
  invoiceId: uuidSchema.optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
});

export async function listCreditNotes(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'credit_note.view');
  const q = parseOrThrow(creditNoteListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 4);
    const where = {
      businessId: ctx.business.id, invoice: locationWhere(scope), ...(q.status ? { status: q.status } : {}), ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lt: new Date(dateOnly(q.to).getTime() + 86_400_000) } : {}) } } : {}),
      AND: words.map((w) => ({ OR: [{ number: { contains: escapeLike(w), mode: 'insensitive' as const } }, { customer: { name: { contains: escapeLike(w), mode: 'insensitive' as const } } }, { invoice: { number: { contains: escapeLike(w), mode: 'insensitive' as const } } }] })),
    };
    const [total, rows] = await seq([
      tx.creditNote.count({ where }),
      tx.creditNote.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { customer: { select: { id: true, name: true } }, invoice: { select: { id: true, number: true } } } }),
    ]);
    return { items: rows.map((r) => ({ id: r.id, number: r.number, status: r.status, totalCents: r.totalCents, appliedCents: r.appliedCents, creditedCents: r.creditedCents, issuedAt: r.issuedAt, createdAt: r.createdAt, reason: r.reason, customer: r.customer, invoice: r.invoice })), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

export async function getCreditNote(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'credit_note.view');
  const cnId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const cn0 = await loadCreditNote(tx, ctx, cnId);
    const [lines, events, customer, invoice, vehicle] = await seq([
      tx.creditNoteLine.findMany({ where: { businessId, creditNoteId: cnId }, orderBy: { position: 'asc' } }),
      tx.financeEvent.findMany({ where: { businessId, entityType: 'credit_note', entityId: cnId }, orderBy: { createdAt: 'desc' } }),
      tx.customer.findFirst({ where: { id: cn0.customerId, businessId }, select: { id: true, name: true } }),
      tx.invoice.findFirst({ where: { id: cn0.invoiceId, businessId }, select: { id: true, number: true, totalCents: true, outstandingCents: true } }),
      cn0.vehicleId ? tx.vehicle.findFirst({ where: { id: cn0.vehicleId, businessId } }) : Promise.resolve(null),
    ]);
    const names = new Map((await tx.user.findMany({ where: { id: { in: [cn0.createdById, cn0.authorisedById, ...events.map((e) => e.actorUserId)].filter((v): v is string => !!v) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const { createdById, authorisedById, ...rest } = cn0;
    return {
      creditNote: { ...rest, createdBy: createdById ? names.get(createdById) ?? null : null, authorisedBy: authorisedById ? names.get(authorisedById) ?? null : null },
      lines: lines.map((l) => ({ ...l, unitCostCents: undefined })), events: events.map((e) => ({ id: e.id, type: e.type, actorName: e.actorUserId ? names.get(e.actorUserId) ?? e.actorName : e.actorName, at: e.createdAt, detail: e.detail })),
      customer, invoice, vehicle: vehicle ? { id: vehicle.id, label: vehicleLabel(vehicle) } : null,
      actions: { issue: can(ctx, 'credit_note.authorise') && cn0.status === 'DRAFT', cancel: can(ctx, 'credit_note.create') && cn0.status === 'DRAFT' },
    };
  });
}
