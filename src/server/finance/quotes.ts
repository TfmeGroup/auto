import { z } from 'zod';
import { seq, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { todayIso } from '@/lib/tz';
import { escapeLike, optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import { jobCreateSchema, openJobTx } from '@/server/jobcards/service';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import { vehicleLabel } from '@/server/vehicles/service';
import type { BusinessContext } from '@/server/context';
import { addDaysIso, canMoveQuote } from './calc';
import {
  dateOnly, isoOf, lineInputSchema, loadFinanceSettings, lockRow, mergeLines, nextDocumentNumber, priceLines, recordFinanceEvent, staffActor, stripCosts, taxContext,
  totalsOf, validateParties, validateWorkRefs, type LineData,
} from './common';
import { createDocumentLink, revokeDocumentLinks } from './links';
import { sendFinanceMessage } from './notify';
import { generateOrQueue } from '@/server/documents/generator';
import { quoteLinesFromJob } from './sources';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
const optionalUuid = z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : undefined));
/** Text that can be cleared: absent = unchanged, "" or null = clear. */
const clearable = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

// Built from default-free fields: absent means "leave as it is" on update.
const contentFields = {
  title: clearable(150),
  description: clearable(2000),
  validUntil: isoDay.optional(),
  terms: clearable(4000),
  customerNotes: clearable(2000),
  discountType: z.enum(['NONE', 'PERCENT', 'FIXED']).optional(),
  discountValue: z.coerce.number().int().min(0).max(2_000_000_000).optional(),
  lines: z.array(lineInputSchema).max(200).optional(),
};

export const quoteCreateSchema = z.object({
  customerId: uuidSchema,
  vehicleId: optionalUuid,
  jobId: optionalUuid,
  locationId: optionalUuid,
  internalNotes: optionalText(2000),
  /** Build the lines from the job's recommended work (needs jobId). */
  fromJob: z.boolean().optional(),
  ...contentFields,
});

export const quoteUpdateSchema = z.object({
  ...contentFields,
  internalNotes: clearable(2000),
  vehicleId: optionalUuid,
  jobId: optionalUuid,
  /** Required when the change creates a new version of a quote the customer has already been sent. */
  changeNote: z.string().trim().min(3, 'Say briefly what changed').max(500).optional(),
});

export const quoteListSchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.string().max(200).optional(),
  customerId: uuidSchema.optional(),
  vehicleId: uuidSchema.optional(),
  jobId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  minCents: z.coerce.number().int().min(0).optional(),
  maxCents: z.coerce.number().int().min(0).optional(),
  expiring: z.enum(['1']).optional(),
  sort: z.enum(['created', 'number', 'total', 'valid_until', 'status']).default('created'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const QUOTE_STATUSES = ['DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'] as const;
export type QuoteStatusValue = (typeof QUOTE_STATUSES)[number];
export const QUOTE_STATUS_LABEL: Record<QuoteStatusValue, string> = {
  DRAFT: 'Draft', SENT: 'Sent', VIEWED: 'Viewed', APPROVED: 'Approved', DECLINED: 'Declined', EXPIRED: 'Expired', CONVERTED: 'Converted to invoice', CANCELLED: 'Cancelled',
};


type QuoteRow = Awaited<ReturnType<Tx['quote']['findFirstOrThrow']>>;

async function userNames(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return new Map();
  const rows = await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Load a quote the caller may see (right business, right location) or "not found". */
export async function loadQuote(tx: Tx, ctx: BusinessContext, id: string): Promise<QuoteRow> {
  const scope = await visibleLocationIds(tx, ctx);
  const q = await tx.quote.findFirst({ where: { id, businessId: ctx.business.id, ...locationWhere(scope) } });
  if (!q) throw Errors.notFound('Quote');
  return q;
}

async function loadQuoteForWrite(tx: Tx, ctx: BusinessContext, id: string): Promise<QuoteRow> {
  await loadQuote(tx, ctx, id);
  await lockRow(tx, 'quotes', ctx.business.id, id);
  return tx.quote.findFirstOrThrow({ where: { id, businessId: ctx.business.id } });
}

/** Copy the headline facts of the current version onto the quote (for lists, filters and expiry). */
async function syncQuoteHeader(tx: Tx, quoteId: string, v: { title: string | null; quoteDate: Date; validUntil: Date | null; totalCents: number }) {
  await tx.quote.update({ where: { id: quoteId }, data: { title: v.title, quoteDate: v.quoteDate, validUntil: v.validUntil, totalCents: v.totalCents } });
}

async function replaceLines(tx: Tx, businessId: string, versionId: string, rows: ReturnType<typeof priceLines>['rows']) {
  await tx.quoteLine.deleteMany({ where: { businessId, versionId } });
  if (rows.length) await tx.quoteLine.createMany({ data: rows.map((r) => ({ ...r, businessId, versionId })) });
}

// ───────────────────────── create ─────────────────────────

export async function createQuote(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'quote.create');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(quoteCreateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const settings = await loadFinanceSettings(tx, businessId);
    const parties = await validateParties(tx, businessId, d);
    const warnings: string[] = [];
    let lines: LineData[] = (d.lines ?? []).map((l) => ({ ...l, unitCostCents: can(ctx, 'finance.view_costs') ? l.unitCostCents : undefined }));
    if (d.fromJob) {
      if (!parties.jobId) throw Errors.validation({ jobId: 'Choose the job to build the quote from.' });
      if (lines.length > 0) throw Errors.validation({ lines: 'Either build the quote from the job or list the lines yourself, not both.' });
      const built = await quoteLinesFromJob(tx, businessId, parties.jobId);
      lines = built.lines;
      warnings.push(...built.warnings);
    }
    await validateWorkRefs(tx, businessId, parties.jobId, lines);
    const tax = taxContext(ctx, settings);
    const { calc, rows } = priceLines(lines, tax, { type: d.discountType ?? 'NONE', value: d.discountValue ?? 0 });

    const today = todayIso(ctx.business.timezone);
    const validUntil = d.validUntil ?? addDaysIso(today, settings.quoteValidityDays);
    if (validUntil < today) throw Errors.validation({ validUntil: 'The quote cannot already be out of date.' });
    const number = await nextDocumentNumber(tx, businessId, 'quote', settings, parties.locationId);

    const quote = await tx.quote.create({
      data: {
        businessId, number, customerId: parties.customerId, vehicleId: parties.vehicleId, jobId: parties.jobId, locationId: parties.locationId,
        internalNotes: d.internalNotes ?? null, createdById: ctx.user.id, updatedById: ctx.user.id,
        title: d.title ?? null, quoteDate: dateOnly(today), validUntil: dateOnly(validUntil), totalCents: calc.totalCents,
      },
    });
    const version = await tx.quoteVersion.create({
      data: {
        businessId, quoteId: quote.id, version: 1, title: d.title ?? null, description: d.description ?? null, quoteDate: dateOnly(today), validUntil: dateOnly(validUntil),
        terms: d.terms === undefined ? settings.quoteTerms : d.terms, customerNotes: d.customerNotes ?? null,
        vatRegistered: tax.vatRegistered, vatRateBps: tax.vatRateBps, pricesIncludeVat: tax.pricesIncludeVat,
        discountType: d.discountType ?? 'NONE', discountValue: d.discountValue ?? 0, ...totalsOf(calc), createdById: ctx.user.id,
      },
    });
    await tx.quoteLine.createMany({ data: rows.map((r) => ({ ...r, businessId, versionId: version.id })) });

    await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quote.id, version: 1, type: 'quote.created', actor: staffActor(ctx), meta: ctx.meta, detail: { fromJob: !!d.fromJob } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.quoteCreated, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quote.id, metadata: { number, totalCents: calc.totalCents, customerId: parties.customerId, jobId: parties.jobId, fromJob: !!d.fromJob } });
    await recordActivity(tx, businessId, ctx.user.id, { type: 'quote.created', summary: `Quote ${number} created`, customerId: parties.customerId, vehicleId: parties.vehicleId, jobId: parties.jobId, data: { quoteId: quote.id } });
    return { id: quote.id, number, warnings };
  });
}

// ───────────────────────── update / new version ─────────────────────────

export async function updateQuote(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'quote.edit');
  assertCanWrite(ctx.subscription);
  const quoteId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(quoteUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const quote = await loadQuoteForWrite(tx, ctx, quoteId);
    const current = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId, businessId, version: quote.currentVersion }, include: { lines: { orderBy: { position: 'asc' } } } });

    const touchesContent = ['title', 'description', 'validUntil', 'terms', 'customerNotes', 'discountType', 'discountValue', 'lines', 'vehicleId', 'jobId'].some((k) => (d as Record<string, unknown>)[k] !== undefined);
    // Internal notes are not part of what the customer saw: change them in place, any time the quote is still live.
    if (!touchesContent) {
      if (d.internalNotes !== undefined) {
        await tx.quote.update({ where: { id: quoteId }, data: { internalNotes: d.internalNotes, updatedById: ctx.user.id } });
        await recordAudit(tx, ctx.meta, { action: AuditActions.quoteUpdated, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quoteId, metadata: { internalNotesOnly: true } });
      }
      return { id: quoteId, version: quote.currentVersion, newVersion: false };
    }

    const frozen = current.sentAt !== null;
    if (frozen && !['SENT', 'VIEWED', 'DECLINED', 'EXPIRED'].includes(quote.status)) {
      throw Errors.conflict(`A ${QUOTE_STATUS_LABEL[quote.status as QuoteStatusValue].toLowerCase()} quote can no longer be changed.${quote.status === 'APPROVED' ? ' Cancel it and create a new quote if the work changed.' : ''}`);
    }
    if (!frozen && quote.status !== 'DRAFT') throw Errors.conflict('This quote cannot be changed in its current state.');
    if (frozen && !d.changeNote) throw Errors.validation({ changeNote: 'This quote has already been sent. Say briefly what changed; the customer will get a new version.' });

    // Customer, vehicle and job are fixed once anything has been sent.
    let vehicleId = quote.vehicleId;
    let jobId = quote.jobId;
    if (d.vehicleId !== undefined || d.jobId !== undefined) {
      if (frozen || quote.currentVersion > 1) throw Errors.conflict('The vehicle and job cannot change once a quote has been sent.');
      const parties = await validateParties(tx, businessId, { customerId: quote.customerId, vehicleId: d.vehicleId ?? quote.vehicleId, jobId: d.jobId ?? quote.jobId, locationId: quote.locationId });
      vehicleId = parties.vehicleId;
      jobId = parties.jobId;
    }

    const settings = await loadFinanceSettings(tx, businessId);
    // A new version, or a draft still being worked on, is priced with the settings in force today.
    const effectiveTax = taxContext(ctx, settings);

    const incomingLines = d.lines ? mergeLines(ctx, d.lines, current.lines) : current.lines.map((l) => ({
      lineType: l.lineType, description: l.description, sku: l.sku ?? undefined, unit: l.unit ?? undefined, quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents,
      discountType: l.discountType, discountValue: l.discountValue, taxTreatment: l.taxTreatment, unitCostCents: l.unitCostCents, jobPartId: l.jobPartId, jobLabourId: l.jobLabourId,
      inventoryItemId: l.inventoryItemId, technicianMembershipId: l.technicianMembershipId, minutes: l.minutes, recommendedWorkId: l.recommendedWorkId ?? undefined,
    } as LineData));
    await validateWorkRefs(tx, businessId, jobId, incomingLines);
    const discountType = d.discountType ?? current.discountType;
    const discountValue = d.discountValue ?? (d.discountType === 'NONE' ? 0 : current.discountValue);
    const { calc, rows } = priceLines(incomingLines, effectiveTax, { type: discountType, value: discountValue });

    const today = todayIso(ctx.business.timezone);
    const validUntil = d.validUntil ?? (frozen ? addDaysIso(today, settings.quoteValidityDays) : isoOf(current.validUntil));
    if (validUntil && validUntil < today) throw Errors.validation({ validUntil: 'The quote cannot already be out of date.' });

    const content = {
      title: d.title === undefined ? current.title : d.title, description: d.description === undefined ? current.description : d.description,
      terms: d.terms === undefined ? current.terms : d.terms, customerNotes: d.customerNotes === undefined ? current.customerNotes : d.customerNotes,
      validUntil: validUntil ? dateOnly(validUntil) : null, discountType, discountValue,
      vatRegistered: effectiveTax.vatRegistered, vatRateBps: effectiveTax.vatRateBps, pricesIncludeVat: effectiveTax.pricesIncludeVat, ...totalsOf(calc),
    };

    let versionRow = current;
    let newVersion = false;
    if (frozen) {
      newVersion = true;
      const next = quote.currentVersion + 1;
      versionRow = await tx.quoteVersion.create({
        data: { businessId, quoteId, version: next, quoteDate: dateOnly(today), changeNote: d.changeNote!, createdById: ctx.user.id, ...content },
        include: { lines: true },
      });
      await tx.quoteLine.createMany({ data: rows.map((r) => ({ ...r, businessId, versionId: versionRow.id })) });
      await tx.quote.update({
        where: { id: quoteId },
        data: { currentVersion: next, status: 'DRAFT', changesRequestedAt: null, declinedAt: null, expiredAt: null, vehicleId, jobId, internalNotes: d.internalNotes === undefined ? undefined : d.internalNotes, updatedById: ctx.user.id },
      });
      await revokeDocumentLinks(tx, businessId, 'QUOTE', quoteId); // the old version can no longer be opened or approved
      await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quoteId, version: next, type: 'quote.version_created', actor: staffActor(ctx), meta: ctx.meta, detail: { changeNote: d.changeNote, previousVersion: quote.currentVersion, previousTotalCents: current.totalCents, totalCents: calc.totalCents } });
      await recordAudit(tx, ctx.meta, { action: AuditActions.quoteVersionCreated, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quoteId, metadata: { version: next, previousVersion: quote.currentVersion, changeNote: d.changeNote, previousTotalCents: current.totalCents, totalCents: calc.totalCents } });
      await recordActivity(tx, businessId, ctx.user.id, { type: 'quote.version_created', summary: `Quote ${quote.number} revised (v${next})`, customerId: quote.customerId, vehicleId, jobId, data: { quoteId } });
    } else {
      await tx.quoteVersion.update({ where: { id: current.id }, data: content });
      await replaceLines(tx, businessId, current.id, rows);
      await tx.quote.update({ where: { id: quoteId }, data: { vehicleId, jobId, internalNotes: d.internalNotes === undefined ? undefined : d.internalNotes, updatedById: ctx.user.id } });
      await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quoteId, version: current.version, type: 'quote.edited', actor: staffActor(ctx), meta: ctx.meta });
      await recordAudit(tx, ctx.meta, { action: AuditActions.quoteUpdated, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quoteId, metadata: { version: current.version, totalCents: calc.totalCents } });
    }
    await syncQuoteHeader(tx, quoteId, { title: content.title, quoteDate: newVersion ? dateOnly(today) : current.quoteDate, validUntil: content.validUntil, totalCents: calc.totalCents });
    return { id: quoteId, version: versionRow.version, newVersion };
  });
}

// ───────────────────────── send ─────────────────────────

/**
 * Send a quote to the customer: freezes the current version (it can never be rewritten, only superseded), moves the quote to
 * Sent, creates the customer's secret link and emails it. Re-sending a quote that is already out issues a fresh link without
 * changing anything the customer sees.
 */
export async function sendQuote(ctx: BusinessContext, id: string, input: unknown = {}) {
  requirePermission(ctx, 'quote.send');
  assertCanWrite(ctx.subscription);
  const quoteId = parseOrThrow(uuidSchema, id);
  const o = parseOrThrow(z.object({ email: z.boolean().default(true) }), input ?? {});
  const out = await sendQuoteTx(ctx, quoteId, o);
  // Freeze what the customer was sent: this version's PDF is stored now, so it can never silently change with later settings.
  await generateOrQueue(ctx.business.id, ctx.user.id, 'quote', quoteId, { dedupeKey: `quote:${quoteId}:v${out.version}:sent`, quoteVersion: out.version });
  return out;
}

async function sendQuoteTx(ctx: BusinessContext, quoteId: string, o: { email: boolean }) {
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const quote = await loadQuoteForWrite(tx, ctx, quoteId);
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId, businessId, version: quote.currentVersion }, include: { lines: true } });
    const resend = ['SENT', 'VIEWED'].includes(quote.status);
    if (!resend && !canMoveQuote(quote.status, 'SENT')) throw Errors.conflict(`A ${QUOTE_STATUS_LABEL[quote.status as QuoteStatusValue].toLowerCase()} quote cannot be sent.`);
    if (version.lines.length === 0) throw Errors.validation({ lines: 'Add at least one line before sending the quote.' });
    const today = todayIso(ctx.business.timezone);
    if (version.validUntil && isoOf(version.validUntil)! < today) throw Errors.validation({ validUntil: 'This quote is out of date. Set a new "valid until" date first.' });

    const now = new Date();
    if (!resend) {
      await tx.quoteVersion.update({ where: { id: version.id }, data: { sentAt: now, sentById: ctx.user.id } });
      await tx.quote.update({ where: { id: quoteId }, data: { status: 'SENT', updatedById: ctx.user.id } });
    }
    const link = await createDocumentLink(tx, businessId, 'QUOTE', quoteId, ctx.user.id);
    let emailed: 'queued' | 'skipped' | 'duplicate' = 'skipped';
    if (o.email) {
      emailed = await sendFinanceMessage(tx, businessId, {
        customerId: quote.customerId, entityType: 'quote', entityId: quoteId, event: 'QUOTE_SENT', vehicleId: quote.vehicleId, locationId: quote.locationId, link: link.url,
        dedupeKey: `quote:${quoteId}:v${version.version}:${resend ? `resend:${Math.floor(now.getTime() / 60_000)}` : 'sent'}`,
        vars: { quote_number: quote.number, quote_total: formatMoney(version.totalCents, ctx.business.currency, ctx.business.locale), valid_until: version.validUntil ? formatDate(version.validUntil, 'UTC', ctx.business.locale) : 'the date shown on the quote' },
      });
    }
    await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quoteId, version: version.version, type: resend ? 'quote.resent' : 'quote.sent', actor: staffActor(ctx), meta: ctx.meta, detail: { emailed } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.quoteSent, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quoteId, metadata: { version: version.version, resend, emailed } });
    await recordActivity(tx, businessId, ctx.user.id, { type: 'quote.sent', summary: `Quote ${quote.number} ${resend ? 're-sent' : 'sent'} (v${version.version})`, customerId: quote.customerId, vehicleId: quote.vehicleId, jobId: quote.jobId, data: { quoteId } });
    return { id: quoteId, status: 'SENT' as const, version: version.version, customerUrl: link.url, emailed: emailed === 'queued' };
  });
}

// ───────────────────────── approval by staff, cancel ─────────────────────────

export const staffApprovalSchema = z.object({
  method: z.enum(['IN_PERSON', 'PHONE', 'WRITTEN', 'OTHER']),
  note: optionalText(500),
  /** The version being approved; guards against approving a screen that has since been revised. */
  version: z.coerce.number().int().min(1),
});

/** A person at the workshop records that the customer approved (in person, by phone, in writing). */
export async function approveQuoteOnBehalf(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'quote.approve');
  assertCanWrite(ctx.subscription);
  const quoteId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(staffApprovalSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const quote = await loadQuoteForWrite(tx, ctx, quoteId);
    if (quote.currentVersion !== d.version) throw Errors.conflict('This quote was revised. Open the latest version before recording approval.', { code: 'QUOTE_VERSION_OUTDATED', currentVersion: quote.currentVersion });
    if (quote.status === 'APPROVED') return { id: quoteId, status: 'APPROVED' as const, alreadyApproved: true };
    if (!canMoveQuote(quote.status, 'APPROVED')) throw Errors.conflict(`A ${QUOTE_STATUS_LABEL[quote.status as QuoteStatusValue].toLowerCase()} quote cannot be approved.`);
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId, businessId, version: quote.currentVersion }, include: { lines: true } });
    if (version.lines.length === 0) throw Errors.validation({ lines: 'The quote has no lines.' });
    if (version.validUntil && isoOf(version.validUntil)! < todayIso(ctx.business.timezone)) throw Errors.conflict('This quote has expired. Revise it with a new validity date first.');
    if (!version.sentAt) await tx.quoteVersion.update({ where: { id: version.id }, data: { sentAt: new Date(), sentById: ctx.user.id } });
    await finaliseApproval(tx, { businessId, quote, version, lines: version.lines, method: d.method, actor: staffActor(ctx), actorUserId: ctx.user.id, meta: ctx.meta, detail: { method: d.method, note: d.note } });
    return { id: quoteId, status: 'APPROVED' as const, alreadyApproved: false };
  });
}

/**
 * The one place a quote becomes Approved, whoever approves (the customer through their link, or staff on their behalf).
 * Records the approval (append-only, one decision per version, enforced by a unique index), moves the quote, makes the
 * approved work available on the job, tells the workshop, and audits it. Called with the quote row locked.
 */
export async function finaliseApproval(
  tx: Tx,
  a: {
    businessId: string; quote: QuoteRow; version: { version: number; totalCents: number }; lines: { lineType: string; description: string; recommendedWorkId: string | null; quantityMilli: number; unitPriceCents: number; taxableCents: number; unitCostCents: number | null; sku: string | null; inventoryItemId: string | null }[];
    method: 'ELECTRONIC' | 'IN_PERSON' | 'PHONE' | 'WRITTEN' | 'OTHER'; actor: Parameters<typeof recordFinanceEvent>[2]['actor']; actorUserId: string | null; meta?: Parameters<typeof recordAudit>[1]; detail: Record<string, unknown>;
  },
): Promise<void> {
  const { businessId, quote } = a;
  const now = new Date();
  await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quote.id, version: a.version.version, type: 'quote.approved', actor: a.actor, meta: a.meta, detail: { ...a.detail, method: a.method, totalCents: a.version.totalCents } });
  await tx.quote.update({ where: { id: quote.id }, data: { status: 'APPROVED', approvedVersion: a.version.version, approvedAt: now, changesRequestedAt: null, ...(a.actorUserId ? { updatedById: a.actorUserId } : {}) } });
  const carried = quote.jobId ? await carryApprovedWorkToJob(tx, { businessId, quote, lines: a.lines, method: a.method, decidedById: a.actorUserId, at: now }) : { superseded: 0 };
  await recordAudit(tx, a.meta, { action: AuditActions.quoteApproved, businessId, userId: a.actorUserId, resourceType: 'quote', resourceId: quote.id, metadata: { version: a.version.version, method: a.method, totalCents: a.version.totalCents, ...(carried.superseded ? { supersededDeclines: carried.superseded } : {}), ...a.detail } });
  await recordActivity(tx, businessId, a.actorUserId, { type: 'quote.approved', summary: `Quote ${quote.number} approved (v${a.version.version}, ${a.method.toLowerCase().replace('_', ' ')})`, customerId: quote.customerId, vehicleId: quote.vehicleId, jobId: quote.jobId, data: { quoteId: quote.id } });
}

/**
 * Approving a quote on a job approves the recommended work its lines refer to (and only those, and only if still undecided),
 * and adds the manual lines to the job as approved work or requested parts. Diagnosis and inspection findings are never touched.
 */
async function carryApprovedWorkToJob(
  tx: Tx,
  a: { businessId: string; quote: QuoteRow; lines: { lineType: string; description: string; recommendedWorkId: string | null; quantityMilli: number; taxableCents: number; unitCostCents: number | null; sku: string | null; inventoryItemId: string | null }[]; method: string; decidedById: string | null; at: Date },
): Promise<{ superseded: number }> {
  const { businessId, quote } = a;
  const jobId = quote.jobId!;
  const note = `Quote ${quote.number}`;
  const method = a.method as 'ELECTRONIC' | 'IN_PERSON' | 'PHONE' | 'WRITTEN' | 'OTHER';
  const refs = a.lines.map((l) => l.recommendedWorkId).filter((v): v is string => !!v);
  let superseded = 0;
  if (refs.length) {
    await tx.recommendedWork.updateMany({
      where: { businessId, jobId, id: { in: refs }, approvalStatus: 'PENDING', completedAt: null },
      data: { approvalStatus: 'APPROVED', approvalMethod: method, decidedAt: a.at, decidedById: a.decidedById, decisionNote: note },
    });
    // A customer who declined an earlier version and then approves a revised one has made a newer, explicit decision about this very work:
    // it must not stay "declined" (the job could never be approved). The earlier decline remains in the quote's history, audit and activity feed.
    superseded = (await tx.recommendedWork.updateMany({
      where: { businessId, jobId, id: { in: refs }, approvalStatus: 'DECLINED', completedAt: null },
      data: { approvalStatus: 'APPROVED', approvalMethod: method, decidedAt: a.at, decidedById: a.decidedById, decisionNote: `${note} (approved after an earlier decline)` },
    })).count;
  }
  await addManualLinesToJob(tx, { businessId, jobId, lines: a.lines.filter((l) => !l.recommendedWorkId), method, at: a.at, decidedById: a.decidedById, note, createdById: a.decidedById });
  return { superseded };
}

async function addManualLinesToJob(
  tx: Tx,
  a: { businessId: string; jobId: string; lines: { lineType: string; description: string; quantityMilli: number; taxableCents: number; unitCostCents: number | null; sku: string | null; inventoryItemId: string | null }[]; method: 'ELECTRONIC' | 'IN_PERSON' | 'PHONE' | 'WRITTEN' | 'OTHER'; at: Date; decidedById: string | null; note: string; createdById: string | null },
) {
  for (const l of a.lines) {
    if (l.lineType === 'CHARGE') continue; // additional charges are billed, not worked
    if (l.lineType === 'PART') {
      const whole = l.quantityMilli % 1000 === 0;
      const quantity = whole ? l.quantityMilli / 1000 : 1;
      await tx.jobPart.create({
        data: {
          businessId: a.businessId, jobId: a.jobId, description: l.description, partNumber: l.sku, quantity,
          costCents: l.unitCostCents, sellPriceCents: whole ? Math.round(l.taxableCents / quantity) : l.taxableCents, inventoryItemId: l.inventoryItemId, status: 'REQUESTED', addedById: a.createdById,
        },
      });
    } else {
      await tx.recommendedWork.create({
        data: {
          businessId: a.businessId, jobId: a.jobId, description: l.description, sourceType: 'MANUAL', priority: 'RECOMMENDED', estimatedLabourCents: l.taxableCents, customerVisible: true,
          approvalStatus: 'APPROVED', approvalMethod: a.method, decidedAt: a.at, decidedById: a.decidedById, decisionNote: a.note, createdById: a.createdById,
        },
      });
    }
  }
}

export const cancelSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

export async function cancelQuote(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'quote.cancel');
  assertCanWrite(ctx.subscription);
  const quoteId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(cancelSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const quote = await loadQuoteForWrite(tx, ctx, quoteId);
    if (quote.status === 'CANCELLED') return { id: quoteId, status: 'CANCELLED' as const };
    if (!canMoveQuote(quote.status, 'CANCELLED')) throw Errors.conflict(`A ${QUOTE_STATUS_LABEL[quote.status as QuoteStatusValue].toLowerCase()} quote cannot be cancelled.`);
    const live = await tx.invoice.count({ where: { businessId, quoteId, status: { not: 'CANCELLED' } } });
    if (live > 0) throw Errors.conflict('An invoice has been created from this quote. Cancel or credit the invoice instead.');
    await tx.quote.update({ where: { id: quoteId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: d.reason, updatedById: ctx.user.id } });
    await revokeDocumentLinks(tx, businessId, 'QUOTE', quoteId);
    await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quoteId, version: quote.currentVersion, type: 'quote.cancelled', actor: staffActor(ctx), meta: ctx.meta, detail: { reason: d.reason, from: quote.status } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.quoteCancelled, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quoteId, before: { status: quote.status }, after: { status: 'CANCELLED' }, metadata: { reason: d.reason } });
    await recordActivity(tx, businessId, ctx.user.id, { type: 'quote.cancelled', summary: `Quote ${quote.number} cancelled`, customerId: quote.customerId, vehicleId: quote.vehicleId, jobId: quote.jobId, data: { quoteId } });
    return { id: quoteId, status: 'CANCELLED' as const };
  });
}

// ───────────────────────── quote -> job ─────────────────────────

/**
 * Create a job card from an approved quote that has no job yet. Uses the existing customer and vehicle (nothing is duplicated)
 * and carries the approved lines across as approved work and requested parts. The quote row is locked and the conversion
 * recorded on it, so two people clicking at once (or a double click) produce exactly one job.
 */
export async function createJobFromQuote(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.create');
  requirePermission(ctx, 'quote.view');
  assertCanWrite(ctx.subscription);
  const quoteId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const quote = await loadQuoteForWrite(tx, ctx, quoteId);
    if (quote.jobId) {
      const job = await tx.jobCard.findFirst({ where: { id: quote.jobId, businessId }, select: { id: true, jobNumber: true } });
      throw Errors.conflict(`This quote already has a job${job ? ` (${job.jobNumber})` : ''}.`, { jobId: quote.jobId });
    }
    if (quote.status !== 'APPROVED' || !quote.approvedVersion) throw Errors.conflict('Only an approved quote can be turned into a job.');
    if (!quote.vehicleId) throw Errors.validation({ vehicleId: 'Add the vehicle to the quote first (a job needs a vehicle).' });
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId, businessId, version: quote.approvedVersion }, include: { lines: { orderBy: { position: 'asc' } } } });
    const approval = await tx.financeEvent.findFirst({ where: { businessId, entityType: 'quote', entityId: quoteId, type: 'quote.approved', version: quote.approvedVersion } });
    const method = ((approval?.detail as { method?: string } | null)?.method ?? 'ELECTRONIC') as 'ELECTRONIC' | 'IN_PERSON' | 'PHONE' | 'WRITTEN' | 'OTHER';

    const data = jobCreateSchema.parse({ customerId: quote.customerId, vehicleId: quote.vehicleId, locationId: quote.locationId ?? undefined, complaint: version.description ?? version.title ?? undefined, serviceLabel: `Quote ${quote.number}`.slice(0, 80), arrived: true });
    const { job } = await openJobTx(ctx, tx, data);
    await addManualLinesToJob(tx, { businessId, jobId: job.id, lines: version.lines, method, at: quote.approvedAt ?? new Date(), decidedById: ctx.user.id, note: `Quote ${quote.number}`, createdById: ctx.user.id });
    await tx.quote.update({ where: { id: quoteId }, data: { jobId: job.id, jobConvertedAt: new Date(), updatedById: ctx.user.id } });
    await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quoteId, version: quote.approvedVersion, type: 'quote.job_created', actor: staffActor(ctx), meta: ctx.meta, detail: { jobId: job.id, jobNumber: job.jobNumber } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.quoteJobCreated, businessId, userId: ctx.user.id, resourceType: 'quote', resourceId: quoteId, metadata: { jobId: job.id, jobNumber: job.jobNumber } });
    return { quoteId, jobId: job.id, jobNumber: job.jobNumber };
  });
}

// ───────────────────────── read ─────────────────────────

export async function getQuote(ctx: BusinessContext, id: string, query: { version?: string } = {}) {
  requirePermission(ctx, 'quote.view');
  const quoteId = parseOrThrow(uuidSchema, id);
  const wanted = query.version ? parseOrThrow(z.coerce.number().int().min(1), query.version) : undefined;
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const quote = await loadQuote(tx, ctx, quoteId);
    const versions = await tx.quoteVersion.findMany({ where: { quoteId, businessId }, orderBy: { version: 'desc' } });
    const shown = versions.find((v) => v.version === (wanted ?? quote.currentVersion));
    if (!shown) throw Errors.notFound('Version');
    const [lines, events, customer, vehicle, job, invoices] = await seq([
      tx.quoteLine.findMany({ where: { businessId, versionId: shown.id }, orderBy: { position: 'asc' } }),
      tx.financeEvent.findMany({ where: { businessId, entityType: 'quote', entityId: quoteId }, orderBy: { createdAt: 'desc' }, take: 200 }),
      tx.customer.findFirst({ where: { id: quote.customerId, businessId }, select: { id: true, name: true, customerNumber: true, email: true, mobile: true } }),
      quote.vehicleId ? tx.vehicle.findFirst({ where: { id: quote.vehicleId, businessId } }) : Promise.resolve(null),
      quote.jobId ? tx.jobCard.findFirst({ where: { id: quote.jobId, businessId }, select: { id: true, jobNumber: true, status: true } }) : Promise.resolve(null),
      tx.invoice.findMany({ where: { businessId, quoteId }, select: { id: true, number: true, status: true, totalCents: true } }),
    ]);
    const names = await userNames(tx, [...versions.map((v) => v.createdById), ...versions.map((v) => v.sentById), ...events.map((e) => e.actorUserId), quote.createdById, quote.updatedById]);
    const decision = events.find((e) => e.version === quote.currentVersion && ['quote.approved', 'quote.declined'].includes(e.type)) ?? null;
    const isCurrent = shown.version === quote.currentVersion;
    const editable = isCurrent && can(ctx, 'quote.edit') && ['DRAFT', 'SENT', 'VIEWED', 'DECLINED', 'EXPIRED'].includes(quote.status);
    const liveInvoice = invoices.find((i) => i.status !== 'CANCELLED') ?? null;
    return {
      quote: {
        id: quote.id, number: quote.number, status: quote.status, currentVersion: quote.currentVersion, approvedVersion: quote.approvedVersion, internalNotes: quote.internalNotes,
        changesRequestedAt: quote.changesRequestedAt, approvedAt: quote.approvedAt, declinedAt: quote.declinedAt, expiredAt: quote.expiredAt, cancelledAt: quote.cancelledAt, cancelReason: quote.cancelReason,
        jobConvertedAt: quote.jobConvertedAt, invoicedAt: quote.invoicedAt, createdAt: quote.createdAt, updatedAt: quote.updatedAt, createdBy: quote.createdById ? names.get(quote.createdById) ?? null : null,
        updatedBy: quote.updatedById ? names.get(quote.updatedById) ?? null : null, locationId: quote.locationId,
      },
      version: {
        version: shown.version, isCurrent, title: shown.title, description: shown.description, quoteDate: isoOf(shown.quoteDate), validUntil: isoOf(shown.validUntil), terms: shown.terms,
        customerNotes: shown.customerNotes, changeNote: shown.changeNote, vatRegistered: shown.vatRegistered, vatRateBps: shown.vatRateBps, pricesIncludeVat: shown.pricesIncludeVat,
        discountType: shown.discountType, discountValue: shown.discountValue, subtotalCents: shown.subtotalCents, discountCents: shown.discountCents, taxableCents: shown.taxableCents,
        vatCents: shown.vatCents, totalCents: shown.totalCents, sentAt: shown.sentAt, frozen: shown.sentAt !== null,
      },
      lines: stripCosts(ctx, lines),
      versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt, createdBy: v.createdById ? names.get(v.createdById) ?? null : null, sentAt: v.sentAt, sentBy: v.sentById ? names.get(v.sentById) ?? null : null, changeNote: v.changeNote, totalCents: v.totalCents })),
      events: events.map((e) => ({ id: e.id, type: e.type, version: e.version, actorKind: e.actorKind, actorName: e.actorUserId ? names.get(e.actorUserId) ?? e.actorName : e.actorName, at: e.createdAt, detail: e.detail })),
      decision: decision ? { type: decision.type, at: decision.createdAt, by: decision.actorName, detail: decision.detail } : null,
      customer, vehicle: vehicle ? { id: vehicle.id, label: vehicleLabel(vehicle), registration: vehicle.registration } : null, job, invoices,
      actions: {
        edit: editable,
        send: can(ctx, 'quote.send') && isCurrent && ['DRAFT', 'SENT', 'VIEWED'].includes(quote.status),
        approve: can(ctx, 'quote.approve') && isCurrent && ['DRAFT', 'SENT', 'VIEWED'].includes(quote.status),
        cancel: can(ctx, 'quote.cancel') && ['DRAFT', 'SENT', 'VIEWED', 'DECLINED', 'EXPIRED', 'APPROVED'].includes(quote.status) && !liveInvoice,
        createJob: can(ctx, 'job.create') && quote.status === 'APPROVED' && !quote.jobId && !!quote.vehicleId,
        createInvoice: can(ctx, 'invoice.create') && quote.status === 'APPROVED' && !liveInvoice,
      },
    };
  });
}

export async function listQuotes(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'quote.view');
  const q = parseOrThrow(quoteListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const scope = await visibleLocationIds(tx, ctx);
    const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5);
    const statuses = (q.status ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s): s is QuoteStatusValue => (QUOTE_STATUSES as readonly string[]).includes(s));
    const today = todayIso(ctx.business.timezone);
    const where = {
      businessId, ...locationWhere(scope),
      ...(statuses.length ? { status: { in: statuses } } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}), ...(q.jobId ? { jobId: q.jobId } : {}), ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.from || q.to ? { quoteDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
      ...(q.minCents !== undefined || q.maxCents !== undefined ? { totalCents: { ...(q.minCents !== undefined ? { gte: q.minCents } : {}), ...(q.maxCents !== undefined ? { lte: q.maxCents } : {}) } } : {}),
      ...(q.expiring ? { status: { in: ['SENT', 'VIEWED'] as ('SENT' | 'VIEWED')[] }, validUntil: { lte: dateOnly(addDaysIso(today, 7)) } } : {}),
      AND: words.map((w) => {
        const norm = w.toUpperCase().replace(/[^A-Z0-9]/g, '') || escapeLike(w);
        const like = escapeLike(w);
        return {
          OR: [
            { number: { contains: like, mode: 'insensitive' as const } },
            { customer: { OR: [{ name: { contains: like, mode: 'insensitive' as const } }, { mobile: { contains: like } }, { email: { contains: like, mode: 'insensitive' as const } }] } },
            { vehicle: { OR: [{ registrationNorm: { contains: norm } }, { vin: { contains: norm, mode: 'insensitive' as const } }] } },
            { job: { jobNumber: { contains: like, mode: 'insensitive' as const } } },
          ],
        };
      }),
    };
    const orderBy = { created: { createdAt: q.dir }, number: { number: q.dir }, total: { totalCents: q.dir }, valid_until: { validUntil: q.dir }, status: { status: q.dir } }[q.sort];
    const [total, rows] = await seq([
      tx.quote.count({ where }),
      tx.quote.findMany({
        where, orderBy: [orderBy, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { customer: { select: { id: true, name: true } }, vehicle: { select: { id: true, registration: true, make: true, model: true, year: true } }, job: { select: { id: true, jobNumber: true } } },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id, number: r.number, status: r.status, version: r.currentVersion, title: r.title, totalCents: r.totalCents, quoteDate: isoOf(r.quoteDate), validUntil: isoOf(r.validUntil),
        customer: r.customer, vehicle: r.vehicle ? { id: r.vehicle.id, label: vehicleLabel(r.vehicle), registration: r.vehicle.registration } : null, job: r.job, changesRequested: !!r.changesRequestedAt, createdAt: r.createdAt,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

/** What a quote on a job looks like to the job screen (a short list, no lines). */
export async function listJobQuotes(ctx: BusinessContext, jobId: string) {
  requirePermission(ctx, 'quote.view');
  const id = parseOrThrow(uuidSchema, jobId);
  return withTenant(ctx.business.id, (tx) =>
    tx.quote.findMany({ where: { businessId: ctx.business.id, jobId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, status: true, totalCents: true, currentVersion: true } }),
  );
}
