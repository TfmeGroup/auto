import { z } from 'zod';
import { Prisma, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { dayRange, todayIso, weekStart } from '@/lib/tz';
import { parseOrThrow } from '@/lib/validation';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import { visibleLocationIds } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import { AGE_BUCKETS, ageBucket, type AgeBucket } from './calc';
import { dateOnly } from './common';

/**
 * Deterministic financial reporting from the real records: no estimates, no stored totals. Everything is computed here from
 * invoices, credit notes, payments, refunds and the credit ledger.
 *
 * Definitions (shown on the screens too):
 *  - Revenue    = what was INVOICED (VAT-exclusive) by invoice date, less credit notes issued in the period. It is not cash.
 *  - Received   = payments that completed in the period (cash in); refunds are shown separately.
 *  - Receivable = what customers still owe on issued invoices right now (outstanding), aged by due date.
 * These are operational figures for running a workshop; they are not accounts and do not replace accounting software.
 */

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
export const rangeSchema = z.object({ from: isoDay.optional(), to: isoDay.optional(), locationId: z.uuid().optional() });

export interface Range {
  from: string;
  to: string;
  /** [start, end) as instants in the business's time zone. */
  start: Date;
  end: Date;
  locationId?: string;
}

export function resolveRange(ctx: BusinessContext, q: unknown): Range {
  const d = parseOrThrow(rangeSchema, q ?? {});
  const today = todayIso(ctx.business.timezone);
  const from = d.from ?? `${today.slice(0, 7)}-01`;
  const to = d.to ?? today;
  if (to < from) throw Errors.validation({ to: 'The end date cannot be before the start date.' });
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 800) throw Errors.validation({ to: 'Choose a period of at most about two years.' });
  return { from, to, start: dayRange(from, ctx.business.timezone).start, end: dayRange(to, ctx.business.timezone).end, locationId: d.locationId };
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** SQL that limits a query on `alias.location_id` to what the caller may see and the optional location filter. */
async function locationSql(tx: Tx, ctx: BusinessContext, alias: string, locationId?: string): Promise<Prisma.Sql> {
  const scope = await visibleLocationIds(tx, ctx);
  const col = Prisma.raw(`${alias}.location_id`);
  const parts: Prisma.Sql[] = [];
  if (scope) parts.push(scope.length ? Prisma.sql`(${col} IS NULL OR ${col} = ANY(${scope}::uuid[]))` : Prisma.sql`${col} IS NULL`);
  if (locationId) parts.push(Prisma.sql`${col} = ${locationId}::uuid`);
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
}

// ───────────────────────── dashboard ─────────────────────────

async function revenueBetween(tx: Tx, ctx: BusinessContext, fromIso: string, toIso: string, locationId?: string) {
  const businessId = ctx.business.id;
  const tz = ctx.business.timezone;
  const start = dayRange(fromIso, tz).start;
  const end = dayRange(toIso, tz).end;
  const loc = await locationSql(tx, ctx, 'i', locationId);
  const inv = await tx.$queryRaw<{ taxable: bigint; vat: bigint; total: bigint; n: number }[]>`
    SELECT COALESCE(SUM(i.taxable_cents),0)::bigint AS taxable, COALESCE(SUM(i.vat_cents),0)::bigint AS vat, COALESCE(SUM(i.total_cents),0)::bigint AS total, COUNT(*)::int AS n
      FROM invoices i
     WHERE i.business_id = ${businessId}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL
       AND i.invoice_date BETWEEN ${dateOnly(fromIso)} AND ${dateOnly(toIso)} ${loc}`;
  const cn = await tx.$queryRaw<{ taxable: bigint; vat: bigint; total: bigint; n: number }[]>`
    SELECT COALESCE(SUM(c.taxable_cents),0)::bigint AS taxable, COALESCE(SUM(c.vat_cents),0)::bigint AS vat, COALESCE(SUM(c.total_cents),0)::bigint AS total, COUNT(*)::int AS n
      FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id
     WHERE c.business_id = ${businessId}::uuid AND c.status = 'ISSUED' AND c.issued_at >= ${start} AND c.issued_at < ${end} ${loc}`;
  const i = inv[0]!;
  const c = cn[0]!;
  return {
    invoicedExVatCents: num(i.taxable), invoicedVatCents: num(i.vat), invoicedTotalCents: num(i.total), invoiceCount: i.n,
    creditNotesExVatCents: num(c.taxable), creditNotesTotalCents: num(c.total), creditNoteCount: c.n,
    revenueCents: num(i.taxable) - num(c.taxable),
  };
}

/** Receivables as of now: what is owed on issued invoices, split by how late it is. */
export async function receivables(tx: Tx, ctx: BusinessContext, locationId?: string) {
  const today = todayIso(ctx.business.timezone);
  const loc = await locationSql(tx, ctx, 'i', locationId);
  const rows = await tx.$queryRaw<{ due_date: Date; amount: bigint; n: number }[]>`
    SELECT i.due_date, SUM(i.outstanding_cents)::bigint AS amount, COUNT(*)::int AS n
      FROM invoices i
     WHERE i.business_id = ${ctx.business.id}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.written_off_at IS NULL AND i.outstanding_cents > 0 ${loc}
     GROUP BY i.due_date`;
  const buckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b, { count: 0, amountCents: 0 }])) as Record<AgeBucket, { count: number; amountCents: number }>;
  let outstanding = 0;
  let overdue = 0;
  let count = 0;
  for (const r of rows) {
    const b = ageBucket(r.due_date.toISOString().slice(0, 10), today);
    buckets[b].count += r.n;
    buckets[b].amountCents += num(r.amount);
    outstanding += num(r.amount);
    count += r.n;
    if (b !== 'current') overdue += num(r.amount);
  }
  return { outstandingCents: outstanding, openInvoices: count, overdueCents: overdue, currentCents: buckets.current.amountCents, ageing: buckets };
}

async function cashBetween(tx: Tx, ctx: BusinessContext, start: Date, end: Date) {
  const businessId = ctx.business.id;
  const p = await tx.payment.aggregate({ where: { businessId, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, paidAt: { gte: start, lt: end } }, _sum: { amountCents: true }, _count: true });
  const r = await tx.refund.aggregate({ where: { businessId, refundedAt: { gte: start, lt: end } }, _sum: { amountCents: true }, _count: true });
  const received = p._sum.amountCents ?? 0;
  const refunded = r._sum.amountCents ?? 0;
  return { receivedCents: received, paymentCount: p._count, refundedCents: refunded, refundCount: r._count, netCents: received - refunded };
}

/** The finance dashboard: the figures a workshop owner looks at every day. Needs finance.view_reports; included on every plan. */
export async function getFinanceDashboard(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'finance.view_reports');
  const range = resolveRange(ctx, query);
  const today = todayIso(ctx.business.timezone);
  const week = weekStart(today);
  const month = `${today.slice(0, 7)}-01`;
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const [todayRev, weekRev, monthRev, rangeRev] = [
      await revenueBetween(tx, ctx, today, today, range.locationId),
      await revenueBetween(tx, ctx, week, today, range.locationId),
      await revenueBetween(tx, ctx, month, today, range.locationId),
      await revenueBetween(tx, ctx, range.from, range.to, range.locationId),
    ];
    const recv = await receivables(tx, ctx, range.locationId);
    const cash = await cashBetween(tx, ctx, range.start, range.end);
    const cashToday = await cashBetween(tx, ctx, dayRange(today, ctx.business.timezone).start, dayRange(today, ctx.business.timezone).end);
    const quotes = await tx.quote.aggregate({ where: { businessId, status: { in: ['SENT', 'VIEWED'] }, validUntil: { gte: dateOnly(today) } }, _sum: { totalCents: true }, _count: true });
    const paidCount = await tx.invoice.count({ where: { businessId, status: 'PAID', paidAt: { gte: range.start, lt: range.end } } });
    const jobInv = await tx.invoice.aggregate({ where: { businessId, finalisedAt: { not: null }, cancelledAt: null, jobId: { not: null }, invoiceDate: { gte: dateOnly(range.from), lte: dateOnly(range.to) } }, _sum: { taxableCents: true }, _count: true });
    return {
      asOf: today, range: { from: range.from, to: range.to },
      revenue: { todayCents: todayRev.revenueCents, weekCents: weekRev.revenueCents, monthCents: monthRev.revenueCents, rangeCents: rangeRev.revenueCents },
      invoiced: { countInRange: rangeRev.invoiceCount, totalInRangeCents: rangeRev.invoicedTotalCents, vatInRangeCents: rangeRev.invoicedVatCents, creditNotesInRangeCents: rangeRev.creditNotesTotalCents, averageInvoiceCents: rangeRev.invoiceCount ? Math.round(rangeRev.invoicedExVatCents / rangeRev.invoiceCount) : 0, paidInRange: paidCount },
      averageJobValueCents: jobInv._count ? Math.round((jobInv._sum.taxableCents ?? 0) / jobInv._count) : null,
      received: { todayCents: cashToday.receivedCents, rangeCents: cash.receivedCents, rangeCount: cash.paymentCount, refundedInRangeCents: cash.refundedCents, netInRangeCents: cash.netCents },
      receivables: recv,
      quotes: { pendingCount: quotes._count, pendingValueCents: quotes._sum.totalCents ?? 0 },
    };
  });
}

// ───────────────────────── ageing detail ─────────────────────────

export async function getAgeingDetail(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'finance.view_reports');
  const q = parseOrThrow(z.object({ bucket: z.enum(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus']).optional(), locationId: z.uuid().optional() }), query ?? {});
  const today = todayIso(ctx.business.timezone);
  return withTenant(ctx.business.id, async (tx) => {
    const loc = await locationSql(tx, ctx, 'i', q.locationId);
    const rows = await tx.$queryRaw<{ id: string; number: string; due_date: Date; outstanding_cents: number; total_cents: number; customer_id: string; customer: string }[]>`
      SELECT i.id, i.number, i.due_date, i.outstanding_cents, i.total_cents, c.id AS customer_id, c.name AS customer
        FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id
       WHERE i.business_id = ${ctx.business.id}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.written_off_at IS NULL AND i.outstanding_cents > 0 ${loc}
       ORDER BY i.due_date ASC, i.number ASC LIMIT 1000`;
    const items = rows.map((r) => {
      const due = r.due_date.toISOString().slice(0, 10);
      return { id: r.id, number: r.number, dueDate: due, bucket: ageBucket(due, today), outstandingCents: r.outstanding_cents, totalCents: r.total_cents, customer: { id: r.customer_id, name: r.customer } };
    });
    return { asOf: today, items: q.bucket ? items.filter((i) => i.bucket === q.bucket) : items };
  });
}

// ───────────────────────── quote analytics ─────────────────────────

export async function getQuoteAnalytics(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'finance.view_reports');
  requirePermission(ctx, 'quote.view');
  requireFeature(ctx.subscription, 'financial_reports');
  const range = resolveRange(ctx, query);
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.quote.groupBy({
      by: ['status'], where: { businessId: ctx.business.id, quoteDate: { gte: dateOnly(range.from), lte: dateOnly(range.to) } }, _count: true, _sum: { totalCents: true },
    });
    const by = (s: string) => rows.find((r) => r.status === s);
    const count = (s: string) => by(s)?._count ?? 0;
    const sum = (s: string) => by(s)?._sum.totalCents ?? 0;
    const approved = count('APPROVED') + count('CONVERTED');
    const sentEver = count('SENT') + count('VIEWED') + approved + count('DECLINED') + count('EXPIRED');
    const totalCount = rows.reduce((a, r) => a + r._count, 0);
    const pctOf = (n: number) => (sentEver ? Math.round((n / sentEver) * 1000) / 10 : null);
    const valueSent = sum('SENT') + sum('VIEWED') + sum('APPROVED') + sum('CONVERTED') + sum('DECLINED') + sum('EXPIRED');
    return {
      range: { from: range.from, to: range.to },
      counts: { total: totalCount, draft: count('DRAFT'), sent: count('SENT'), viewed: count('VIEWED'), approved: count('APPROVED'), declined: count('DECLINED'), expired: count('EXPIRED'), converted: count('CONVERTED'), cancelled: count('CANCELLED') },
      approvalRatePct: pctOf(approved), declineRatePct: pctOf(count('DECLINED')),
      averageQuoteValueCents: sentEver ? Math.round(valueSent / sentEver) : 0,
      approvedValueCents: sum('APPROVED') + sum('CONVERTED'), outstandingValueCents: sum('SENT') + sum('VIEWED'),
      note: 'Rates are of quotes that were sent to customers in the period (approved + declined + expired + still open).',
    };
  });
}

// ───────────────────────── payment analytics ─────────────────────────

export async function getPaymentAnalytics(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'finance.view_reports');
  requirePermission(ctx, 'payment.view');
  requireFeature(ctx.subscription, 'financial_reports');
  const range = resolveRange(ctx, query);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const byMethod = await tx.payment.groupBy({ by: ['method'], where: { businessId, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, paidAt: { gte: range.start, lt: range.end } }, _sum: { amountCents: true }, _count: true });
    const refunds = await tx.refund.aggregate({ where: { businessId, refundedAt: { gte: range.start, lt: range.end } }, _sum: { amountCents: true }, _count: true });
    const credit = await tx.customerCreditEntry.groupBy({ by: ['kind'], where: { businessId, createdAt: { gte: range.start, lt: range.end } }, _sum: { amountCents: true } });
    const recv = await receivables(tx, ctx, range.locationId);
    const get = (m: string) => byMethod.find((r) => r.method === m);
    const total = byMethod.reduce((a, r) => a + (r._sum.amountCents ?? 0), 0);
    const kinds = (k: string) => credit.find((c) => c.kind === k)?._sum.amountCents ?? 0;
    return {
      range: { from: range.from, to: range.to },
      totalReceivedCents: total, paymentCount: byMethod.reduce((a, r) => a + r._count, 0),
      byMethod: (['ONLINE', 'EFT', 'CASH', 'CARD', 'OTHER'] as const).map((m) => ({ method: m, count: get(m)?._count ?? 0, amountCents: get(m)?._sum.amountCents ?? 0 })),
      refundedCents: refunds._sum.amountCents ?? 0, refundCount: refunds._count,
      creditIssuedCents: kinds('DEPOSIT') + kinds('OVERPAYMENT') + kinds('CREDIT_NOTE'), creditAppliedCents: -kinds('APPLIED'),
      outstandingCents: recv.outstandingCents,
    };
  });
}

// ───────────────────────── profitability ─────────────────────────

/**
 * Operational gross profit: invoiced revenue (VAT-exclusive) less the cost recorded on those invoice lines. Costs were copied onto
 * each line when it was created (parts' cost price, technician cost rate x time), so later price or rate changes never rewrite
 * history. Lines with no cost recorded are counted and shown, never guessed. Credit notes reduce revenue but not cost here.
 * This is not net profit and not accounts: it leaves out overheads, wages beyond recorded labour cost, tax and so on.
 */
export async function getProfitability(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'finance.view_reports');
  requirePermission(ctx, 'finance.view_costs');
  requireFeature(ctx.subscription, 'financial_reports');
  const range = resolveRange(ctx, query);
  return withTenant(ctx.business.id, async (tx) => {
    const loc = await locationSql(tx, ctx, 'i', range.locationId);
    const rows = await tx.$queryRaw<{ line_type: string; revenue: bigint; cost: bigint; uncosted_revenue: bigint; uncosted_lines: number; lines: number }[]>`
      SELECT l.line_type::text AS line_type, COALESCE(SUM(l.taxable_cents),0)::bigint AS revenue,
             COALESCE(SUM(CASE WHEN l.unit_cost_cents IS NOT NULL THEN ROUND(l.quantity_milli::numeric * l.unit_cost_cents / 1000) ELSE 0 END),0)::bigint AS cost,
             COALESCE(SUM(CASE WHEN l.unit_cost_cents IS NULL THEN l.taxable_cents ELSE 0 END),0)::bigint AS uncosted_revenue,
             COUNT(*) FILTER (WHERE l.unit_cost_cents IS NULL)::int AS uncosted_lines, COUNT(*)::int AS lines
        FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.business_id = l.business_id
       WHERE i.business_id = ${ctx.business.id}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL
         AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${loc}
       GROUP BY l.line_type`;
    const byType = rows.map((r) => ({ lineType: r.line_type, revenueCents: num(r.revenue), costCents: num(r.cost), profitCents: num(r.revenue) - num(r.cost), uncostedLines: r.uncosted_lines, uncostedRevenueCents: num(r.uncosted_revenue) }));
    const sum = (k: 'revenueCents' | 'costCents' | 'uncostedRevenueCents' | 'uncostedLines') => byType.reduce((a, r) => a + r[k], 0);
    const get = (t: string) => byType.find((r) => r.lineType === t);
    const revenue = sum('revenueCents');
    const cost = sum('costCents');
    return {
      range: { from: range.from, to: range.to },
      revenueCents: revenue, partsCostCents: get('PART')?.costCents ?? 0, labourCostCents: get('LABOUR')?.costCents ?? 0, totalCostCents: cost,
      grossProfitCents: revenue - cost, grossMarginPct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
      partsRevenueCents: get('PART')?.revenueCents ?? 0, labourRevenueCents: get('LABOUR')?.revenueCents ?? 0,
      uncostedLines: sum('uncostedLines'), uncostedRevenueCents: sum('uncostedRevenueCents'), byLineType: byType,
      note: 'Operational gross profit from costs recorded on invoice lines. Lines without a recorded cost are counted as zero cost: see the uncosted figures.',
    };
  });
}

// ───────────────────────── VAT (operational) ─────────────────────────

/** VAT facts retained on invoices and credit notes for the period, for handing to an accountant. Not a VAT return. */
export async function getVatReport(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'finance.view_reports');
  requireFeature(ctx.subscription, 'financial_reports');
  const range = resolveRange(ctx, query);
  return withTenant(ctx.business.id, async (tx) => {
    const loc = await locationSql(tx, ctx, 'i', range.locationId);
    const inv = await tx.$queryRaw<{ treatment: string; rate: number; taxable: bigint; vat: bigint; n: number }[]>`
      SELECT l.tax_treatment::text AS treatment, l.vat_rate_bps AS rate, COALESCE(SUM(l.taxable_cents),0)::bigint AS taxable, COALESCE(SUM(l.vat_cents),0)::bigint AS vat, COUNT(DISTINCT i.id)::int AS n
        FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.business_id = l.business_id
       WHERE i.business_id = ${ctx.business.id}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL
         AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${loc}
       GROUP BY l.tax_treatment, l.vat_rate_bps ORDER BY l.vat_rate_bps DESC`;
    const cn = await tx.$queryRaw<{ treatment: string; rate: number; taxable: bigint; vat: bigint; n: number }[]>`
      SELECT l.tax_treatment::text AS treatment, l.vat_rate_bps AS rate, COALESCE(SUM(l.taxable_cents),0)::bigint AS taxable, COALESCE(SUM(l.vat_cents),0)::bigint AS vat, COUNT(DISTINCT c.id)::int AS n
        FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id AND c.business_id = l.business_id JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id
       WHERE c.business_id = ${ctx.business.id}::uuid AND c.status = 'ISSUED' AND c.issued_at >= ${range.start} AND c.issued_at < ${range.end} ${loc}
       GROUP BY l.tax_treatment, l.vat_rate_bps ORDER BY l.vat_rate_bps DESC`;
    const map = (rows: typeof inv) => rows.map((r) => ({ treatment: r.treatment, rateBps: r.rate, taxableCents: num(r.taxable), vatCents: num(r.vat), documents: r.n }));
    const i = map(inv);
    const c = map(cn);
    return {
      range: { from: range.from, to: range.to }, vatRegistered: ctx.business.vatRegistered,
      invoices: i, creditNotes: c,
      outputVatCents: i.reduce((a, r) => a + r.vatCents, 0) - c.reduce((a, r) => a + r.vatCents, 0),
      taxableSalesCents: i.reduce((a, r) => a + r.taxableCents, 0) - c.reduce((a, r) => a + r.taxableCents, 0),
      note: 'Operational VAT data from issued invoices and credit notes, for your accountant. It is not a VAT return.',
    };
  });
}
