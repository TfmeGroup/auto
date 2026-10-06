import { z } from 'zod';
import { seq, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { todayIso } from '@/lib/tz';
import { escapeLike, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import { vehicleLabel } from '@/server/vehicles/service';
import type { BusinessContext } from '@/server/context';
import { addDaysIso, calculateDocument, deriveInvoiceState, type TaxContext } from './calc';
import {
  businessSnapshot, customerSnapshot, dateOnly, isoOf, lineInputSchema, loadFinanceSettings, lockRow, mergeLines, nextDocumentNumber, priceLines, recordFinanceEvent, staffActor, stripCosts,
  taxContext, toCalcInput, totalsOf, validateParties, validateWorkRefs, type LineData,
} from './common';
import { generateOrQueue } from '@/server/documents/generator';
import { creditBalance, recomputeInvoice } from './ledger';
import { createDocumentLink, revokeDocumentLinks } from './links';
import { sendFinanceMessage } from './notify';
import { invoiceLinesFromJob } from './sources';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
const optionalUuid = z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : undefined));
const clearable = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

const contentFields = {
  title: clearable(150),
  customerNotes: clearable(2000),
  internalNotes: clearable(2000),
  terms: clearable(4000),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  invoiceDate: isoDay.optional(),
  dueDate: isoDay.optional(),
  discountType: z.enum(['NONE', 'PERCENT', 'FIXED']).optional(),
  discountValue: z.coerce.number().int().min(0).max(2_000_000_000).optional(),
  lines: z.array(lineInputSchema).max(200).optional(),
};

export const invoiceCreateSchema = z.object({ customerId: uuidSchema, vehicleId: optionalUuid, jobId: optionalUuid, locationId: optionalUuid, ...contentFields });
export const invoiceUpdateSchema = z.object({ ...contentFields, vehicleId: optionalUuid });

const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'SENT', 'VIEWED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'WRITTEN_OFF'] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABEL: Record<InvoiceStatusValue, string> = {
  DRAFT: 'Draft', ISSUED: 'Issued', SENT: 'Sent', VIEWED: 'Viewed', PARTIALLY_PAID: 'Partially paid', PAID: 'Paid', OVERDUE: 'Overdue', CANCELLED: 'Cancelled', WRITTEN_OFF: 'Written off',
};

export const invoiceListSchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.string().max(200).optional(),
  customerId: uuidSchema.optional(),
  vehicleId: uuidSchema.optional(),
  jobId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  technicianId: uuidSchema.optional(),
  method: z.enum(['CARD', 'EFT', 'CASH', 'ONLINE', 'OTHER']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  dueFrom: isoDay.optional(),
  dueTo: isoDay.optional(),
  minCents: z.coerce.number().int().min(0).optional(),
  maxCents: z.coerce.number().int().min(0).optional(),
  overdue: z.enum(['1']).optional(),
  payment: z.enum(['paid', 'unpaid']).optional(),
  sort: z.enum(['created', 'number', 'total', 'outstanding', 'invoice_date', 'due_date', 'status']).default('created'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

type InvoiceRow = Awaited<ReturnType<Tx['invoice']['findFirstOrThrow']>>;

export async function loadInvoice(tx: Tx, ctx: BusinessContext, id: string): Promise<InvoiceRow> {
  const scope = await visibleLocationIds(tx, ctx);
  const inv = await tx.invoice.findFirst({ where: { id, businessId: ctx.business.id, ...locationWhere(scope) } });
  if (!inv) throw Errors.notFound('Invoice');
  return inv;
}

async function loadInvoiceForWrite(tx: Tx, ctx: BusinessContext, id: string): Promise<InvoiceRow> {
  await loadInvoice(tx, ctx, id);
  await lockRow(tx, 'invoices', ctx.business.id, id);
  return tx.invoice.findFirstOrThrow({ where: { id, businessId: ctx.business.id } });
}

/** The status the invoice has RIGHT NOW (a due date that has passed makes it Overdue even before the scheduler has noticed). */
export function presentState(inv: InvoiceRow, tz: string) {
  return deriveInvoiceState(
    {
      totalCents: inv.totalCents, paidCents: inv.paidCents, creditAppliedCents: inv.creditAppliedCents, creditNotedCents: inv.creditNotedCents, writtenOffCents: inv.writtenOffCents,
      finalised: inv.finalisedAt !== null, cancelled: inv.cancelledAt !== null, writtenOff: inv.writtenOffAt !== null, sent: inv.sentAt !== null, viewed: inv.viewedAt !== null, dueDate: isoOf(inv.dueDate),
    },
    todayIso(tz),
  );
}

async function assertNoLiveInvoice(tx: Tx, businessId: string, where: { jobId?: string | null; quoteId?: string | null }) {
  if (where.jobId) {
    const x = await tx.invoice.findFirst({ where: { businessId, jobId: where.jobId, status: { not: 'CANCELLED' } }, select: { id: true, number: true } });
    if (x) throw Errors.conflict(`This job already has an invoice${x.number ? ` (${x.number})` : ' (a draft)'}. Cancel it first if it needs to be redone.`, { invoiceId: x.id });
  }
  if (where.quoteId) {
    const x = await tx.invoice.findFirst({ where: { businessId, quoteId: where.quoteId, status: { not: 'CANCELLED' } }, select: { id: true, number: true } });
    if (x) throw Errors.conflict(`This quote has already been invoiced${x.number ? ` (${x.number})` : ' (a draft invoice exists)'}.`, { invoiceId: x.id });
  }
}

interface DraftSource {
  quoteId?: string | null;
  quoteVersion?: number | null;
  tax?: TaxContext;
  discount?: { type: 'NONE' | 'PERCENT' | 'FIXED'; value: number };
  warnings?: string[];
}

async function insertDraft(
  tx: Tx,
  ctx: BusinessContext,
  parties: { customerId: string; vehicleId: string | null; jobId: string | null; locationId: string | null },
  d: { title?: string | null; customerNotes?: string | null; internalNotes?: string | null; terms?: string | null; paymentTermsDays?: number; invoiceDate?: string; dueDate?: string; discountType?: 'NONE' | 'PERCENT' | 'FIXED'; discountValue?: number },
  lines: LineData[],
  src: DraftSource,
) {
  const businessId = ctx.business.id;
  const settings = await loadFinanceSettings(tx, businessId);
  await validateWorkRefs(tx, businessId, parties.jobId, lines);
  const tax = src.tax ?? taxContext(ctx, settings);
  const discount = src.discount ?? { type: d.discountType ?? 'NONE', value: d.discountValue ?? 0 };
  const { calc, rows } = priceLines(lines, tax, discount);
  const terms = d.paymentTermsDays ?? settings.paymentTermsDays;
  if (d.invoiceDate && d.dueDate && d.dueDate < d.invoiceDate) throw Errors.validation({ dueDate: 'The due date cannot be before the invoice date.' });
  const inv = await tx.invoice.create({
    data: {
      businessId, customerId: parties.customerId, vehicleId: parties.vehicleId, jobId: parties.jobId, quoteId: src.quoteId ?? null, quoteVersion: src.quoteVersion ?? null, locationId: parties.locationId,
      title: d.title ?? null, customerNotes: d.customerNotes ?? null, internalNotes: d.internalNotes ?? null, terms: d.terms === undefined ? settings.invoiceTerms : d.terms,
      paymentTermsDays: terms, invoiceDate: d.invoiceDate ? dateOnly(d.invoiceDate) : null, dueDate: d.dueDate ? dateOnly(d.dueDate) : null,
      vatRegistered: tax.vatRegistered, vatRateBps: tax.vatRateBps, pricesIncludeVat: tax.pricesIncludeVat, discountType: discount.type, discountValue: discount.value,
      ...totalsOf(calc), outstandingCents: calc.totalCents, createdById: ctx.user.id, updatedById: ctx.user.id,
    },
  });
  if (rows.length) await tx.invoiceLine.createMany({ data: rows.map((r, i) => ({ ...r, businessId, invoiceId: inv.id, quoteLineId: lines[i]!.quoteLineId ?? null })) });
  return { inv, calc };
}

async function afterCreate(tx: Tx, ctx: BusinessContext, inv: InvoiceRow, extra: Record<string, unknown>) {
  const businessId = ctx.business.id;
  await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: inv.id, type: 'invoice.created', actor: staffActor(ctx), meta: ctx.meta, detail: { totalCents: inv.totalCents, ...extra } });
  await recordAudit(tx, ctx.meta, { action: AuditActions.invoiceCreated, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: inv.id, metadata: { totalCents: inv.totalCents, customerId: inv.customerId, jobId: inv.jobId, quoteId: inv.quoteId, ...extra } });
  await recordActivity(tx, businessId, ctx.user.id, { type: 'invoice.created', summary: 'Draft invoice created', customerId: inv.customerId, vehicleId: inv.vehicleId, jobId: inv.jobId, data: { invoiceId: inv.id } });
}

// ───────────────────────── create ─────────────────────────

export async function createInvoice(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'invoice.create');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(invoiceCreateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const parties = await validateParties(tx, ctx.business.id, d);
    await assertNoLiveInvoice(tx, ctx.business.id, { jobId: parties.jobId });
    const lines: LineData[] = (d.lines ?? []).map((l) => ({ ...l, unitCostCents: can(ctx, 'finance.view_costs') ? l.unitCostCents : undefined }));
    const { inv } = await insertDraft(tx, ctx, parties, d, lines, {});
    await afterCreate(tx, ctx, inv, { source: 'manual' });
    return { id: inv.id, warnings: [] as string[] };
  });
}

const BILLABLE_JOB_STATUSES = ['READY_FOR_COLLECTION', 'COMPLETED'];

/** Draft an invoice from what actually happened on a finished job (see sources.ts for what is and is not billed). */
export async function createInvoiceFromJob(ctx: BusinessContext, jobId: string) {
  requirePermission(ctx, 'invoice.create');
  assertCanWrite(ctx.subscription);
  const id = parseOrThrow(uuidSchema, jobId);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const scope = await visibleLocationIds(tx, ctx);
    const job = await tx.jobCard.findFirst({ where: { id, businessId, ...locationWhere(scope) } });
    if (!job) throw Errors.notFound('Job');
    if (!BILLABLE_JOB_STATUSES.includes(job.status)) throw Errors.conflict('Invoice a job once it is ready for collection or completed.');
    await assertNoLiveInvoice(tx, businessId, { jobId: id });
    const built = await invoiceLinesFromJob(tx, businessId, id);
    if (built.quoteId) await assertNoLiveInvoice(tx, businessId, { quoteId: built.quoteId });
    const parties = await validateParties(tx, businessId, { customerId: job.customerId, vehicleId: job.vehicleId, jobId: job.id, locationId: job.locationId });
    if (built.lines.length === 0) throw Errors.validation({ lines: 'Nothing billable has been recorded on this job yet: no fitted parts or labour. Add them to the job, or create the invoice by hand.' });
    const { inv } = await insertDraft(tx, ctx, parties, {}, built.lines, { quoteId: built.quoteId, quoteVersion: built.quoteVersion });
    if (built.quoteId) await markQuoteInvoiced(tx, ctx, built.quoteId, inv.id);
    await afterCreate(tx, ctx, inv, { source: 'job', jobId: id });
    return { id: inv.id, warnings: built.warnings };
  });
}

async function markQuoteInvoiced(tx: Tx, ctx: BusinessContext, quoteId: string, invoiceId: string) {
  const businessId = ctx.business.id;
  await lockRow(tx, 'quotes', businessId, quoteId);
  const q = await tx.quote.findFirstOrThrow({ where: { id: quoteId, businessId } });
  if (q.status === 'APPROVED') await tx.quote.update({ where: { id: quoteId }, data: { status: 'CONVERTED', invoicedAt: new Date(), updatedById: ctx.user.id } });
  await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quoteId, version: q.approvedVersion, type: 'quote.converted_to_invoice', actor: staffActor(ctx), meta: ctx.meta, detail: { invoiceId } });
  await recordAudit(tx, ctx.meta, { action: AuditActions.quoteConvertedToInvoice, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quoteId, metadata: { invoiceId } });
}

/**
 * Draft an invoice from an APPROVED quote: a separate record that links back to the quote and the version the customer
 * approved. The lines and the tax facts come from that version, so the invoice total equals what was approved; the quote
 * itself is never changed beyond being marked as converted. A quote can be invoiced once (database-enforced).
 */
export async function createInvoiceFromQuote(ctx: BusinessContext, quoteId: string) {
  requirePermission(ctx, 'invoice.create');
  requirePermission(ctx, 'quote.view');
  assertCanWrite(ctx.subscription);
  const id = parseOrThrow(uuidSchema, quoteId);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    await lockRow(tx, 'quotes', businessId, id);
    const scope = await visibleLocationIds(tx, ctx);
    const quote = await tx.quote.findFirst({ where: { id, businessId, ...locationWhere(scope) } });
    if (!quote) throw Errors.notFound('Quote');
    if (quote.status !== 'APPROVED' || !quote.approvedVersion) throw Errors.conflict(quote.status === 'CONVERTED' ? 'This quote has already been invoiced.' : 'Only an approved quote can be invoiced.');
    await assertNoLiveInvoice(tx, businessId, { quoteId: id, jobId: quote.jobId });
    const v = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId: id, businessId, version: quote.approvedVersion }, include: { lines: { orderBy: { position: 'asc' } } } });
    const parties = await validateParties(tx, businessId, { customerId: quote.customerId, vehicleId: quote.vehicleId, jobId: quote.jobId, locationId: quote.locationId });
    const lines: LineData[] = v.lines.map((l) => ({
      lineType: l.lineType, description: l.description, sku: l.sku ?? undefined, unit: l.unit ?? undefined, quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents,
      discountType: l.discountType, discountValue: l.discountValue, taxTreatment: l.taxTreatment, unitCostCents: l.unitCostCents, jobPartId: l.jobPartId, jobLabourId: l.jobLabourId,
      inventoryItemId: l.inventoryItemId, technicianMembershipId: l.technicianMembershipId, minutes: l.minutes, recommendedWorkId: l.recommendedWorkId ?? undefined, quoteLineId: l.id,
    }));
    const tax = { vatRegistered: v.vatRegistered, vatRateBps: v.vatRateBps, pricesIncludeVat: v.pricesIncludeVat };
    const { inv, calc } = await insertDraft(tx, ctx, parties, { customerNotes: v.customerNotes }, lines, { quoteId: id, quoteVersion: v.version, tax, discount: { type: v.discountType, value: v.discountValue } });
    // The server's own recalculation must land exactly on what the customer approved.
    if (calc.totalCents !== v.totalCents) throw Errors.conflict('The invoice total did not match the approved quote. Nothing was created; please contact support.');
    await markQuoteInvoiced(tx, ctx, id, inv.id);
    await afterCreate(tx, ctx, inv, { source: 'quote', quoteId: id, quoteVersion: v.version });
    return { id: inv.id, warnings: [] as string[] };
  });
}

// ───────────────────────── update (drafts only) ─────────────────────────

export async function updateInvoice(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'invoice.edit');
  assertCanWrite(ctx.subscription);
  const invoiceId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(invoiceUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const inv = await loadInvoiceForWrite(tx, ctx, invoiceId);
    if (inv.status !== 'DRAFT') {
      // The only thing an issued invoice allows is a private note; money, parties and wording are locked (and so in the database).
      const onlyInternal = Object.keys(d).every((k) => k === 'internalNotes' || (d as Record<string, unknown>)[k] === undefined);
      if (!onlyInternal || d.internalNotes === undefined) throw Errors.conflict('An issued invoice cannot be edited. Issue a credit note to correct it.');
      await tx.invoice.update({ where: { id: invoiceId }, data: { internalNotes: d.internalNotes, updatedById: ctx.user.id } });
      await recordAudit(tx, ctx.meta, { action: AuditActions.invoiceUpdated, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: invoiceId, metadata: { internalNotesOnly: true } });
      return { id: invoiceId };
    }
    const existing = await tx.invoiceLine.findMany({ where: { invoiceId, businessId }, orderBy: { position: 'asc' } });
    const settings = await loadFinanceSettings(tx, businessId);

    let vehicleId = inv.vehicleId;
    if (d.vehicleId !== undefined) {
      const p = await validateParties(tx, businessId, { customerId: inv.customerId, vehicleId: d.vehicleId, jobId: inv.jobId, locationId: inv.locationId });
      vehicleId = p.vehicleId;
    }
    const lines: LineData[] = d.lines ? mergeLines(ctx, d.lines, existing) : existing.map((l) => ({
      lineType: l.lineType, description: l.description, sku: l.sku ?? undefined, unit: l.unit ?? undefined, quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents,
      discountType: l.discountType, discountValue: l.discountValue, taxTreatment: l.taxTreatment, unitCostCents: l.unitCostCents, jobPartId: l.jobPartId, jobLabourId: l.jobLabourId,
      inventoryItemId: l.inventoryItemId, technicianMembershipId: l.technicianMembershipId, minutes: l.minutes, recommendedWorkId: l.recommendedWorkId ?? undefined, quoteLineId: l.quoteLineId,
    }));
    await validateWorkRefs(tx, businessId, inv.jobId, lines);
    // A quote-derived invoice keeps the tax facts the customer approved; any other draft follows today's settings.
    const tax: TaxContext = inv.quoteId ? { vatRegistered: inv.vatRegistered, vatRateBps: inv.vatRateBps, pricesIncludeVat: inv.pricesIncludeVat } : taxContext(ctx, settings);
    const discountType = d.discountType ?? inv.discountType;
    const discountValue = d.discountValue ?? (d.discountType === 'NONE' ? 0 : inv.discountValue);
    const { calc, rows } = priceLines(lines, tax, { type: discountType, value: discountValue });
    const invoiceDate = d.invoiceDate ?? isoOf(inv.invoiceDate);
    const dueDate = d.dueDate ?? isoOf(inv.dueDate);
    if (invoiceDate && dueDate && dueDate < invoiceDate) throw Errors.validation({ dueDate: 'The due date cannot be before the invoice date.' });

    await tx.invoiceLine.deleteMany({ where: { invoiceId, businessId } });
    if (rows.length) await tx.invoiceLine.createMany({ data: rows.map((r, i) => ({ ...r, businessId, invoiceId, quoteLineId: lines[i]!.quoteLineId ?? null })) });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        vehicleId, title: d.title === undefined ? undefined : d.title, customerNotes: d.customerNotes === undefined ? undefined : d.customerNotes, internalNotes: d.internalNotes === undefined ? undefined : d.internalNotes,
        terms: d.terms === undefined ? undefined : d.terms, paymentTermsDays: d.paymentTermsDays, invoiceDate: invoiceDate ? dateOnly(invoiceDate) : null, dueDate: dueDate ? dateOnly(dueDate) : null,
        vatRegistered: tax.vatRegistered, vatRateBps: tax.vatRateBps, pricesIncludeVat: tax.pricesIncludeVat, discountType, discountValue, ...totalsOf(calc), outstandingCents: calc.totalCents, updatedById: ctx.user.id,
      },
    });
    await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: invoiceId, type: 'invoice.edited', actor: staffActor(ctx), meta: ctx.meta, detail: { totalCents: calc.totalCents } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.invoiceUpdated, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: invoiceId, before: { totalCents: inv.totalCents }, after: { totalCents: calc.totalCents } });
    return { id: invoiceId };
  });
}

// ───────────────────────── finalise, send, cancel, write off ─────────────────────────

/**
 * Issue a draft: allocate the invoice number, fix the dates, freeze the business and customer details as they are today, and
 * lock the money. From here the database refuses edits to numbers, parties, dates, tax facts and totals (migration 0006);
 * corrections go through credit notes.
 */
export async function finaliseInvoice(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'invoice.finalise');
  assertCanWrite(ctx.subscription);
  const invoiceId = parseOrThrow(uuidSchema, id);
  const out = await withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const inv = await loadInvoiceForWrite(tx, ctx, invoiceId);
    if (inv.status !== 'DRAFT') {
      if (inv.finalisedAt) return { id: invoiceId, number: inv.number!, already: true };
      throw Errors.conflict('Only a draft invoice can be issued.');
    }
    const lines = await tx.invoiceLine.findMany({ where: { invoiceId, businessId }, orderBy: { position: 'asc' } });
    if (lines.length === 0) throw Errors.validation({ lines: 'Add at least one line before issuing the invoice.' });

    // Integrity: the stored totals must be exactly what the stored lines and tax facts produce.
    const check = calculateDocument(lines.map((l) => toCalcInput({ ...l, quantityMilli: l.quantityMilli })), { vatRegistered: inv.vatRegistered, vatRateBps: inv.vatRateBps, pricesIncludeVat: inv.pricesIncludeVat }, { type: inv.discountType, value: inv.discountValue });
    if (check.totalCents !== inv.totalCents || check.vatCents !== inv.vatCents) throw Errors.conflict('The invoice totals are out of date. Open the draft and save it again before issuing.');
    if (inv.totalCents <= 0) throw Errors.validation({ lines: 'An invoice must have a total greater than zero.' });

    const settings = await loadFinanceSettings(tx, businessId);
    const today = todayIso(ctx.business.timezone);
    const invoiceDate = isoOf(inv.invoiceDate) ?? today;
    const dueDate = isoOf(inv.dueDate) ?? addDaysIso(invoiceDate, inv.paymentTermsDays || settings.paymentTermsDays);
    if (dueDate < invoiceDate) throw Errors.validation({ dueDate: 'The due date cannot be before the invoice date.' });
    const number = await nextDocumentNumber(tx, businessId, 'invoice', settings, inv.locationId);

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        number, status: 'ISSUED', paymentStatus: 'UNPAID', invoiceDate: dateOnly(invoiceDate), dueDate: dateOnly(dueDate), finalisedAt: new Date(), finalisedById: ctx.user.id, updatedById: ctx.user.id,
        businessSnapshot: await businessSnapshot(tx, businessId, settings, inv.locationId), customerSnapshot: await customerSnapshot(tx, businessId, inv.customerId),
      },
    });
    const done = await recomputeInvoice(tx, businessId, invoiceId);
    await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: invoiceId, type: 'invoice.finalised', actor: staffActor(ctx), meta: ctx.meta, detail: { number, totalCents: done.totalCents, dueDate } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.invoiceFinalised, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: invoiceId, before: { status: 'DRAFT' }, after: { status: done.status, number }, metadata: { totalCents: done.totalCents, vatCents: done.vatCents, dueDate } });
    await recordActivity(tx, businessId, ctx.user.id, { type: 'invoice.finalised', summary: `Invoice ${number} issued`, customerId: inv.customerId, vehicleId: inv.vehicleId, jobId: inv.jobId, data: { invoiceId } });
    return { id: invoiceId, number, already: false };
  });
  if (!out.already) {
    // File the issued PDF in the document store (version 1 of this invoice's documents). If that fails it is queued for retry:
    // the invoice is valid either way and the PDF can always be rendered again from the stored record.
    await generateOrQueue(ctx.business.id, ctx.user.id, 'invoice', invoiceId, { dedupeKey: `invoice:${invoiceId}:issued` });
  }
  return out;
}

export async function sendInvoice(ctx: BusinessContext, id: string, input: unknown = {}) {
  requirePermission(ctx, 'invoice.send');
  assertCanWrite(ctx.subscription);
  const invoiceId = parseOrThrow(uuidSchema, id);
  const o = parseOrThrow(z.object({ email: z.boolean().default(true) }), input ?? {});
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const inv = await loadInvoiceForWrite(tx, ctx, invoiceId);
    if (!inv.finalisedAt || !inv.number) throw Errors.conflict('Issue the invoice before sending it.');
    if (inv.cancelledAt) throw Errors.conflict('A cancelled invoice cannot be sent.');
    const first = inv.sentAt === null;
    if (first) await tx.invoice.update({ where: { id: invoiceId }, data: { sentAt: new Date(), updatedById: ctx.user.id } });
    const done = await recomputeInvoice(tx, businessId, invoiceId);
    const link = await createDocumentLink(tx, businessId, 'INVOICE', invoiceId, ctx.user.id);
    let emailed: 'queued' | 'skipped' | 'duplicate' = 'skipped';
    if (o.email) {
      emailed = await sendFinanceMessage(tx, businessId, {
        customerId: inv.customerId, entityType: 'invoice', entityId: invoiceId, event: 'INVOICE_SENT', vehicleId: inv.vehicleId, locationId: inv.locationId, link: link.url,
        dedupeKey: `invoice:${invoiceId}:${first ? 'sent' : `resend:${Math.floor(Date.now() / 60_000)}`}`,
        vars: { invoice_number: inv.number!, invoice_total: formatMoney(inv.totalCents, ctx.business.currency, ctx.business.locale), due_date: formatDate(inv.dueDate!, 'UTC', ctx.business.locale) },
      });
    }
    await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: invoiceId, type: first ? 'invoice.sent' : 'invoice.resent', actor: staffActor(ctx), meta: ctx.meta, detail: { emailed } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.invoiceSent, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: invoiceId, metadata: { resend: !first, emailed } });
    return { id: invoiceId, status: done.status, customerUrl: link.url, emailed: emailed === 'queued' };
  });
}

export const invoiceCancelSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

/**
 * Cancel an invoice. A draft can always be cancelled. An issued invoice only if nothing has been paid, credited or noted
 * against it: money that has moved is corrected with a refund and a credit note, never by making the invoice disappear.
 */
export async function cancelInvoice(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'invoice.cancel');
  assertCanWrite(ctx.subscription);
  const invoiceId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(invoiceCancelSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const inv = await loadInvoiceForWrite(tx, ctx, invoiceId);
    if (inv.cancelledAt) return { id: invoiceId, status: 'CANCELLED' as const };
    if (inv.status === 'WRITTEN_OFF') throw Errors.conflict('A written-off invoice cannot be cancelled.');
    if (inv.finalisedAt) {
      const payments = await tx.payment.count({ where: { businessId, invoiceId, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } } });
      const credited = await tx.creditNote.count({ where: { businessId, invoiceId, status: { not: 'CANCELLED' } } });
      const applied = await tx.customerCreditEntry.count({ where: { businessId, invoiceId } });
      if (payments > 0 || credited > 0 || applied > 0) throw Errors.conflict('This invoice has payments, credit or credit notes against it, so it cannot be cancelled. Refund the payments and issue a credit note instead.');
    }
    // A checkout the customer has started but not finished is closed. If money still arrives for it, it is kept as customer credit.
    await tx.payment.updateMany({ where: { businessId, invoiceId, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'CANCELLED', failureReason: 'The invoice was cancelled' } });
    await tx.invoice.update({ where: { id: invoiceId }, data: { cancelledAt: new Date(), cancelReason: d.reason, updatedById: ctx.user.id } });
    await recomputeInvoice(tx, businessId, invoiceId);
    await revokeDocumentLinks(tx, businessId, 'INVOICE', invoiceId);
    if (inv.quoteId) {
      await lockRow(tx, 'quotes', businessId, inv.quoteId);
      const q = await tx.quote.findFirstOrThrow({ where: { id: inv.quoteId, businessId } });
      if (q.status === 'CONVERTED') await tx.quote.update({ where: { id: q.id }, data: { status: 'APPROVED', invoicedAt: null } });
    }
    await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: invoiceId, type: 'invoice.cancelled', actor: staffActor(ctx), meta: ctx.meta, detail: { reason: d.reason, wasIssued: !!inv.finalisedAt } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.invoiceCancelled, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: invoiceId, before: { status: inv.status }, after: { status: 'CANCELLED' }, metadata: { reason: d.reason, number: inv.number } });
    return { id: invoiceId, status: 'CANCELLED' as const };
  });
}

export const writeOffSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

/** Write the remaining balance off as bad debt. Nothing is deleted: the invoice keeps its history and shows what was written off. */
export async function writeOffInvoice(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'invoice.write_off');
  assertCanWrite(ctx.subscription);
  const invoiceId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(writeOffSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const inv = await loadInvoiceForWrite(tx, ctx, invoiceId);
    if (inv.writtenOffAt) return { id: invoiceId, status: 'WRITTEN_OFF' as const, writtenOffCents: inv.writtenOffCents };
    if (!inv.finalisedAt || inv.cancelledAt) throw Errors.conflict('Only an issued, open invoice can be written off.');
    const fresh = await recomputeInvoice(tx, businessId, invoiceId);
    if (fresh.outstandingCents <= 0) throw Errors.conflict('Nothing is outstanding on this invoice.');
    // The balance columns must stay consistent in the same statement (the database checks total - settled = outstanding).
    await tx.invoice.update({ where: { id: invoiceId }, data: { writtenOffAt: new Date(), writtenOffCents: fresh.outstandingCents, outstandingCents: 0, status: 'WRITTEN_OFF', paymentStatus: 'WRITTEN_OFF', writeOffReason: d.reason, updatedById: ctx.user.id } });
    const done = await recomputeInvoice(tx, businessId, invoiceId);
    await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: invoiceId, type: 'invoice.written_off', actor: staffActor(ctx), meta: ctx.meta, detail: { reason: d.reason, writtenOffCents: fresh.outstandingCents } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.invoiceWrittenOff, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: invoiceId, before: { status: inv.status, outstandingCents: fresh.outstandingCents }, after: { status: done.status }, metadata: { reason: d.reason, number: inv.number } });
    return { id: invoiceId, status: done.status, writtenOffCents: fresh.outstandingCents };
  });
}

// ───────────────────────── read ─────────────────────────

export async function getInvoice(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'invoice.view');
  const invoiceId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const inv = await loadInvoice(tx, ctx, invoiceId);
    const state = presentState(inv, ctx.business.timezone);
    const [lines, payments, creditNotes, credits, events, customer, vehicle, job, quote] = await seq([
      tx.invoiceLine.findMany({ where: { invoiceId, businessId }, orderBy: { position: 'asc' } }),
      tx.payment.findMany({ where: { businessId, invoiceId }, orderBy: { createdAt: 'desc' }, include: { refunds: { orderBy: { refundedAt: 'desc' } }, receipt: { select: { id: true, number: true } } } }),
      tx.creditNote.findMany({ where: { businessId, invoiceId }, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, status: true, totalCents: true, appliedCents: true, creditedCents: true, issuedAt: true } }),
      tx.customerCreditEntry.findMany({ where: { businessId, invoiceId }, orderBy: { createdAt: 'desc' } }),
      tx.financeEvent.findMany({ where: { businessId, entityType: 'invoice', entityId: invoiceId }, orderBy: { createdAt: 'desc' }, take: 200 }),
      tx.customer.findFirst({ where: { id: inv.customerId, businessId }, select: { id: true, name: true, customerNumber: true, email: true, mobile: true } }),
      inv.vehicleId ? tx.vehicle.findFirst({ where: { id: inv.vehicleId, businessId } }) : Promise.resolve(null),
      inv.jobId ? tx.jobCard.findFirst({ where: { id: inv.jobId, businessId }, select: { id: true, jobNumber: true, status: true } }) : Promise.resolve(null),
      inv.quoteId ? tx.quote.findFirst({ where: { id: inv.quoteId, businessId }, select: { id: true, number: true } }) : Promise.resolve(null),
    ]);
    const credit = await creditBalance(tx, businessId, inv.customerId);
    const names = new Map((await tx.user.findMany({ where: { id: { in: [inv.createdById, inv.finalisedById, ...events.map((e) => e.actorUserId)].filter((v): v is string => !!v) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const open = state.outstandingCents > 0 && !!inv.finalisedAt && !inv.cancelledAt && !inv.writtenOffAt;
    const costs = can(ctx, 'finance.view_costs');
    const costCents = costs ? lines.reduce((a, l) => a + (l.unitCostCents === null ? 0 : Math.round((l.quantityMilli * l.unitCostCents) / 1000)), 0) : null;
    const { businessSnapshot: bs, customerSnapshot: cs, ...rest } = inv;
    return {
      invoice: { ...rest, status: state.status, paymentStatus: state.paymentStatus, outstandingCents: state.outstandingCents, invoiceDate: isoOf(inv.invoiceDate), dueDate: isoOf(inv.dueDate), createdBy: inv.createdById ? names.get(inv.createdById) ?? null : null, finalisedBy: inv.finalisedById ? names.get(inv.finalisedById) ?? null : null, hasSnapshot: !!bs && !!cs },
      lines: stripCosts(ctx, lines),
      payments: payments.map((p) => ({
        id: p.id, number: p.number, status: p.status, method: p.method, amountCents: p.amountCents, appliedCents: p.appliedCents, creditedCents: p.creditedCents, reference: p.reference, paidAt: p.paidAt, provider: p.provider,
        refundedCents: p.refundedAppliedCents + p.refundedCreditCents, receipt: p.receipt, refunds: p.refunds.map((r) => ({ id: r.id, number: r.number, amountCents: r.amountCents, reason: r.reason, refundedAt: r.refundedAt })),
      })),
      creditNotes,
      creditApplications: credits.filter((c) => c.kind === 'APPLIED').map((c) => ({ id: c.id, amountCents: -c.amountCents, at: c.createdAt, note: c.note })),
      events: events.map((e) => ({ id: e.id, type: e.type, actorKind: e.actorKind, actorName: e.actorUserId ? names.get(e.actorUserId) ?? e.actorName : e.actorName, at: e.createdAt, detail: e.detail })),
      customer, vehicle: vehicle ? { id: vehicle.id, label: vehicleLabel(vehicle), registration: vehicle.registration } : null, job, quote,
      customerCreditCents: credit,
      profit: costs ? { costCents: costCents!, revenueCents: inv.taxableCents, grossProfitCents: inv.taxableCents - costCents! } : null,
      actions: {
        edit: can(ctx, 'invoice.edit') && inv.status === 'DRAFT',
        finalise: can(ctx, 'invoice.finalise') && inv.status === 'DRAFT',
        send: can(ctx, 'invoice.send') && !!inv.finalisedAt && !inv.cancelledAt,
        recordPayment: can(ctx, 'payment.create') && open,
        applyCredit: can(ctx, 'payment.apply_credit') && open && credit > 0,
        creditNote: can(ctx, 'credit_note.create') && !!inv.finalisedAt && !inv.cancelledAt,
        cancel: can(ctx, 'invoice.cancel') && !inv.cancelledAt && inv.status !== 'WRITTEN_OFF' && (!inv.finalisedAt || (inv.paidCents + inv.creditAppliedCents + inv.creditNotedCents === 0 && payments.length === 0)),
        writeOff: can(ctx, 'invoice.write_off') && open,
      },
    };
  });
}

export async function listInvoices(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'invoice.view');
  const q = parseOrThrow(invoiceListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const scope = await visibleLocationIds(tx, ctx);
    const today = todayIso(ctx.business.timezone);
    const overduePredicate = { finalisedAt: { not: null }, cancelledAt: null, writtenOffAt: null, outstandingCents: { gt: 0 }, dueDate: { lt: dateOnly(today) } };
    const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5);
    const wanted = (q.status ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s): s is InvoiceStatusValue => (INVOICE_STATUSES as readonly string[]).includes(s));
    const ors: object[] = [];
    for (const s of wanted) {
      if (s === 'OVERDUE') ors.push(overduePredicate);
      else if (['ISSUED', 'SENT', 'VIEWED', 'PARTIALLY_PAID'].includes(s)) ors.push({ status: s, NOT: overduePredicate });
      else ors.push({ status: s });
    }
    const and: object[] = [];
    if (ors.length) and.push({ OR: ors });
    if (q.overdue) and.push(overduePredicate);
    if (q.payment === 'paid') and.push({ paymentStatus: 'PAID' });
    if (q.payment === 'unpaid') and.push({ finalisedAt: { not: null }, cancelledAt: null, writtenOffAt: null, outstandingCents: { gt: 0 } });
    if (q.technicianId) and.push({ OR: [{ job: { primaryTechnicianMembershipId: q.technicianId } }, { lines: { some: { technicianMembershipId: q.technicianId } } }] });
    if (q.method) and.push({ payments: { some: { method: q.method, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } } } });
    for (const w of words) {
      const norm = w.toUpperCase().replace(/[^A-Z0-9]/g, '') || escapeLike(w);
      const like = escapeLike(w);
      and.push({
        OR: [
          { number: { contains: like, mode: 'insensitive' } },
          { customer: { OR: [{ name: { contains: like, mode: 'insensitive' } }, { mobile: { contains: like } }, { email: { contains: like, mode: 'insensitive' } }] } },
          { vehicle: { OR: [{ registrationNorm: { contains: norm } }, { vin: { contains: norm, mode: 'insensitive' } }] } },
          { job: { jobNumber: { contains: like, mode: 'insensitive' } } },
          { quote: { number: { contains: like, mode: 'insensitive' } } },
        ],
      });
    }
    const where = {
      businessId, ...locationWhere(scope),
      ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}), ...(q.jobId ? { jobId: q.jobId } : {}), ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.from || q.to ? { invoiceDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
      ...(q.dueFrom || q.dueTo ? { dueDate: { ...(q.dueFrom ? { gte: dateOnly(q.dueFrom) } : {}), ...(q.dueTo ? { lte: dateOnly(q.dueTo) } : {}) } } : {}),
      ...(q.minCents !== undefined || q.maxCents !== undefined ? { totalCents: { ...(q.minCents !== undefined ? { gte: q.minCents } : {}), ...(q.maxCents !== undefined ? { lte: q.maxCents } : {}) } } : {}),
      AND: and,
    };
    const orderBy = { created: { createdAt: q.dir }, number: { number: q.dir }, total: { totalCents: q.dir }, outstanding: { outstandingCents: q.dir }, invoice_date: { invoiceDate: q.dir }, due_date: { dueDate: q.dir }, status: { status: q.dir } }[q.sort];
    const [total, rows] = await seq([
      tx.invoice.count({ where: where as never }),
      tx.invoice.findMany({
        where: where as never, orderBy: [orderBy, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { customer: { select: { id: true, name: true } }, vehicle: { select: { id: true, registration: true, make: true, model: true, year: true } }, job: { select: { id: true, jobNumber: true } } },
      }),
    ]);
    return {
      items: rows.map((r) => {
        const s = presentState(r, ctx.business.timezone);
        return {
          id: r.id, number: r.number, status: s.status, paymentStatus: s.paymentStatus, totalCents: r.totalCents, paidCents: r.paidCents + r.creditAppliedCents, outstandingCents: s.outstandingCents, invoiceDate: isoOf(r.invoiceDate),
          dueDate: isoOf(r.dueDate), customer: r.customer, vehicle: r.vehicle ? { id: r.vehicle.id, label: vehicleLabel(r.vehicle), registration: r.vehicle.registration } : null, job: r.job, createdAt: r.createdAt,
        };
      }),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function listJobInvoices(ctx: BusinessContext, jobId: string) {
  requirePermission(ctx, 'invoice.view');
  const id = parseOrThrow(uuidSchema, jobId);
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.invoice.findMany({ where: { businessId: ctx.business.id, jobId: id }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({ id: r.id, number: r.number, status: presentState(r, ctx.business.timezone).status, totalCents: r.totalCents, outstandingCents: presentState(r, ctx.business.timezone).outstandingCents }));
  });
}
