import { Prisma } from '@/server/db/client';
import { dateOnly } from '@/server/finance/common';
import { AGE_BUCKETS } from '@/server/finance/calc';
import { BUCKET_LABEL, bar, bucketSql, col, fillPeriods, isoDay, localDate, n, nn, pageOf, pct, periodLabel, UNIT_GROUPS, unitFor, unitSql } from './util';
import type { ReportDef, RunEnv } from '../types';

/**
 * Money reports, all read from invoices, credit notes, payments, refunds and the credit ledger.
 *   Invoiced  = issued invoices by invoice date, VAT-exclusive (revenue); cancelled invoices are left out, written-off ones stay in.
 *   Received  = payments that completed in the period (cash in), shown separately from what was invoiced.
 *   Outstanding = what customers still owe on issued invoices.
 */

const PAID_STATUSES = Prisma.sql`('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')`;

const techJoin = (env: RunEnv) => (env.params.technicianId ? Prisma.sql`JOIN job_cards jt ON jt.id = i.job_id AND jt.business_id = i.business_id AND jt.primary_technician_membership_id = ${env.params.technicianId}::uuid` : Prisma.empty);
const custIn = (env: RunEnv, alias: string) => (env.params.customerId ? Prisma.sql`AND ${Prisma.raw(alias)}.customer_id = ${env.params.customerId}::uuid` : Prisma.empty);

// ───────────────────────── revenue ─────────────────────────

export const revenue: ReportDef = {
  key: 'revenue', title: 'Revenue', category: 'financial', dated: true, sensitive: true,
  description: 'What was invoiced, what was received and what is still owed, by day, week or month. Invoiced and received are different things.',
  permissions: ['finance.view_reports'], filters: ['range', 'location', 'customer', 'technician'], groupBys: UNIT_GROUPS,
  async run(env) {
    const { tx, ctx, range } = env;
    const bid = ctx.business.id;
    const unit = unitFor(env);
    const tz = ctx.business.timezone;
    const u = unitSql(unit);
    const loc = env.loc('i');
    const inv = await tx.$queryRaw<{ period: Date; ex: bigint; vat: bigint; total: bigint; outstanding: bigint; n: number }[]>(Prisma.sql`
      SELECT date_trunc(${u}, i.invoice_date)::date AS period, COALESCE(SUM(i.taxable_cents),0)::bigint AS ex, COALESCE(SUM(i.vat_cents),0)::bigint AS vat, COALESCE(SUM(i.total_cents),0)::bigint AS total,
             COALESCE(SUM(CASE WHEN i.written_off_at IS NULL THEN i.outstanding_cents ELSE 0 END),0)::bigint AS outstanding, COUNT(*)::int AS n
        FROM invoices i ${techJoin(env)}
       WHERE i.business_id = ${bid}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL
         AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${loc} ${custIn(env, 'i')}
       GROUP BY 1`);
    const cn = await tx.$queryRaw<{ period: Date; ex: bigint; total: bigint }[]>(Prisma.sql`
      SELECT date_trunc(${u}, ${localDate('c.issued_at', tz)})::date AS period, COALESCE(SUM(c.taxable_cents),0)::bigint AS ex, COALESCE(SUM(c.total_cents),0)::bigint AS total
        FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id ${techJoin(env)}
       WHERE c.business_id = ${bid}::uuid AND c.status = 'ISSUED' AND c.issued_at >= ${range.start} AND c.issued_at < ${range.end} ${loc} ${custIn(env, 'c')}
       GROUP BY 1`);
    const pay = await tx.$queryRaw<{ period: Date; amount: bigint; n: number }[]>(Prisma.sql`
      SELECT date_trunc(${u}, ${localDate('p.paid_at', tz)})::date AS period, COALESCE(SUM(p.amount_cents),0)::bigint AS amount, COUNT(*)::int AS n
        FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id ${techJoin(env)}
       WHERE p.business_id = ${bid}::uuid AND p.status IN ${PAID_STATUSES} AND p.paid_at >= ${range.start} AND p.paid_at < ${range.end} ${loc} ${custIn(env, 'p')}
       GROUP BY 1`);
    const ref = await tx.$queryRaw<{ period: Date; amount: bigint }[]>(Prisma.sql`
      SELECT date_trunc(${u}, ${localDate('r.refunded_at', tz)})::date AS period, COALESCE(SUM(r.amount_cents),0)::bigint AS amount
        FROM refunds r JOIN payments p ON p.id = r.payment_id AND p.business_id = r.business_id
        LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id ${techJoin(env)}
       WHERE r.business_id = ${bid}::uuid AND r.refunded_at >= ${range.start} AND r.refunded_at < ${range.end} ${loc} ${custIn(env, 'r')}
       GROUP BY 1`);

    const by = <T extends { period: Date }>(rows: T[]) => new Map(rows.map((r) => [isoDay(r.period)!, r]));
    const iM = by(inv), cM = by(cn), pM = by(pay), rM = by(ref);
    const keys = fillPeriods(env, unit, [], (p) => ({ period: p })).map((r) => r.period);
    const rows = keys.map((p) => {
      const i = iM.get(p), c = cM.get(p), pa = pM.get(p), r = rM.get(p);
      const invoiced = n(i?.ex), credits = n(c?.ex), received = n(pa?.amount), refunds = n(r?.amount);
      return {
        period: periodLabel(p, unit), invoices: n(i?.n), invoicedExVat: invoiced, vat: n(i?.vat), creditNotes: credits, netRevenue: invoiced - credits,
        received, refunds, netCash: received - refunds, outstanding: n(i?.outstanding),
      };
    });
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (r[k] as number), 0);
    const total = {
      invoiced: sum('invoicedExVat'), credits: sum('creditNotes'), vat: sum('vat'), received: sum('received'), refunds: sum('refunds'), outstanding: sum('outstanding'), count: sum('invoices'),
    };
    return {
      columns: [
        col('period', unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month', 'text'), col('invoices', 'Invoices', 'int'), col('invoicedExVat', 'Invoiced (ex VAT)', 'money'), col('vat', 'VAT on invoices', 'money'),
        col('creditNotes', 'Credit notes (ex VAT)', 'money'), col('netRevenue', 'Net revenue (ex VAT)', 'money'), col('received', 'Cash received', 'money'), col('refunds', 'Refunds paid', 'money'),
        col('netCash', 'Net cash', 'money'), col('outstanding', 'Still owed on these invoices', 'money'),
      ],
      rows,
      summary: [
        { key: 'netRevenue', label: 'Net revenue (ex VAT)', value: total.invoiced - total.credits, type: 'money', hint: 'Invoiced less credit notes' },
        { key: 'invoiced', label: 'Invoiced (ex VAT)', value: total.invoiced, type: 'money', hint: `${total.count} invoice${total.count === 1 ? '' : 's'}` },
        { key: 'credits', label: 'Credit notes (ex VAT)', value: total.credits, type: 'money' },
        { key: 'received', label: 'Cash received', value: total.received, type: 'money', hint: 'Payments in the period, not revenue' },
        { key: 'refunds', label: 'Refunds paid', value: total.refunds, type: 'money' },
        { key: 'outstanding', label: 'Still owed on these invoices', value: total.outstanding, type: 'money', tone: total.outstanding > 0 ? 'warn' : undefined },
      ],
      charts: [bar('Net revenue and cash received', 'money', rows.map((r) => r.period), [{ name: 'Net revenue (ex VAT)', values: rows.map((r) => r.netRevenue) }, { name: 'Cash received', values: rows.map((r) => r.received) }])],
      notes: [
        'Revenue is what was invoiced (VAT excluded) by invoice date, less credit notes issued. Cash received is shown separately and is not revenue.',
        'Technician filter uses the technician in charge of the job the invoice is for.',
      ],
    };
  },
};

// ───────────────────────── invoices ─────────────────────────

/** One mutually exclusive status per issued invoice: cancelled > written off > paid > overdue > partially paid > unpaid. */
const invoiceStatusSql = (today: string) => Prisma.sql`CASE WHEN i.cancelled_at IS NOT NULL THEN 'CANCELLED' WHEN i.written_off_at IS NOT NULL THEN 'WRITTEN_OFF'
  WHEN i.outstanding_cents <= 0 THEN 'PAID' WHEN i.due_date IS NOT NULL AND i.due_date < ${today}::date THEN 'OVERDUE'
  WHEN i.outstanding_cents < i.total_cents THEN 'PARTIALLY_PAID' ELSE 'UNPAID' END`;

const INVOICE_STATUS_LABEL: Record<string, string> = { PAID: 'Paid', PARTIALLY_PAID: 'Partially paid', UNPAID: 'Unpaid', OVERDUE: 'Overdue', CANCELLED: 'Cancelled', WRITTEN_OFF: 'Written off' };

export const invoices: ReportDef = {
  key: 'invoices', title: 'Invoices', category: 'financial', dated: true, paged: true, sensitive: true,
  description: 'Every issued invoice with its payment status, plus counts and an ageing view of what is still open.',
  permissions: ['finance.view_reports', 'invoice.view'], filters: ['range', 'location', 'customer', 'invoiceStatus', 'search'],
  async run(env) {
    const { tx, ctx, range, params, today } = env;
    const bid = ctx.business.id;
    const status = invoiceStatusSql(today);
    const search = params.search ? Prisma.sql`AND (i.number ILIKE ${`%${params.search.replace(/[\\%_]/g, '\\$&')}%`} OR c.name ILIKE ${`%${params.search.replace(/[\\%_]/g, '\\$&')}%`})` : Prisma.empty;
    const base = Prisma.sql`
      FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id LEFT JOIN vehicles v ON v.id = i.vehicle_id AND v.business_id = i.business_id
     WHERE i.business_id = ${bid}::uuid AND i.finalised_at IS NOT NULL AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)}
       ${env.loc('i')} ${custIn(env, 'i')} ${search}`;
    const statusFilter = params.invoiceStatus ? Prisma.sql`WHERE q.pstatus = ${params.invoiceStatus}` : Prisma.empty;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; number: string; invoice_date: Date; due_date: Date | null; customer_id: string; customer: string; vehicle_id: string | null; registration: string | null; total: number; paid: number; outstanding: number; pstatus: string }[]>(Prisma.sql`
      SELECT * FROM (SELECT i.id, i.number, i.invoice_date, i.due_date, c.id AS customer_id, c.name AS customer, v.id AS vehicle_id, v.registration, i.total_cents AS total,
             (i.paid_cents + i.credit_applied_cents) AS paid, i.outstanding_cents AS outstanding, ${status} AS pstatus ${base}) q ${statusFilter}
       ORDER BY q.invoice_date DESC, q.number DESC LIMIT ${limit} OFFSET ${offset}`);
    const agg = await tx.$queryRaw<{ pstatus: string; n: number; total: bigint; outstanding: bigint }[]>(Prisma.sql`
      SELECT q.pstatus, COUNT(*)::int AS n, COALESCE(SUM(q.total),0)::bigint AS total, COALESCE(SUM(q.outstanding),0)::bigint AS outstanding
        FROM (SELECT i.total_cents AS total, i.outstanding_cents AS outstanding, ${status} AS pstatus ${base}) q ${statusFilter} GROUP BY q.pstatus`);
    const g = (s: string) => agg.find((a) => a.pstatus === s);
    const count = agg.reduce((a, r) => a + r.n, 0);
    const value = agg.filter((a) => a.pstatus !== 'CANCELLED').reduce((a, r) => a + n(r.total), 0);
    const live = agg.filter((a) => a.pstatus !== 'CANCELLED').reduce((a, r) => a + r.n, 0);
    // Ageing is as of today for everything still owed (the date range does not apply to what is open now).
    const ageing = await ageingBuckets(env);
    return {
      columns: [
        col('number', 'Invoice', 'text', { link: { path: '/invoices', idKey: 'id' } }), col('invoiceDate', 'Date', 'date'), col('dueDate', 'Due', 'date'),
        col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }), col('registration', 'Vehicle', 'text', { link: { path: '/vehicles', idKey: 'vehicleId' } }),
        col('status', 'Status', 'status'), col('total', 'Total (incl. VAT)', 'money'), col('paid', 'Paid / credited', 'money'), col('outstanding', 'Outstanding', 'money'),
      ],
      rows: rows.map((r) => ({
        id: r.id, number: r.number, invoiceDate: isoDay(r.invoice_date), dueDate: isoDay(r.due_date), customerId: r.customer_id, customer: r.customer, vehicleId: r.vehicle_id, registration: r.registration,
        status: INVOICE_STATUS_LABEL[r.pstatus] ?? r.pstatus, total: r.total, paid: r.paid, outstanding: r.outstanding,
      })),
      total: count,
      summary: [
        { key: 'count', label: 'Invoices', value: count, type: 'int' },
        { key: 'value', label: 'Invoice value (incl. VAT)', value, type: 'money', hint: 'Excludes cancelled invoices' },
        { key: 'average', label: 'Average invoice (incl. VAT)', value: live ? Math.round(value / live) : null, type: 'money' },
        { key: 'paid', label: 'Paid', value: g('PAID')?.n ?? 0, type: 'int' },
        { key: 'partial', label: 'Partially paid', value: g('PARTIALLY_PAID')?.n ?? 0, type: 'int' },
        { key: 'unpaid', label: 'Unpaid', value: g('UNPAID')?.n ?? 0, type: 'int' },
        { key: 'overdue', label: 'Overdue', value: g('OVERDUE')?.n ?? 0, type: 'int', tone: (g('OVERDUE')?.n ?? 0) > 0 ? 'danger' : undefined },
        { key: 'cancelled', label: 'Cancelled', value: g('CANCELLED')?.n ?? 0, type: 'int' },
        { key: 'writtenOff', label: 'Written off', value: g('WRITTEN_OFF')?.n ?? 0, type: 'int' },
      ],
      charts: [
        bar('Invoices by status', 'int', Object.values(INVOICE_STATUS_LABEL), [{ name: 'Invoices', values: Object.keys(INVOICE_STATUS_LABEL).map((s) => g(s)?.n ?? 0) }]),
        bar('Ageing of what is still owed (today)', 'money', AGE_BUCKETS.map((b) => BUCKET_LABEL[b]!), [{ name: 'Outstanding', values: AGE_BUCKETS.map((b) => ageing[b].amount) }]),
      ],
      notes: [
        'Each invoice has one status: cancelled, written off, paid, overdue (owing and past its due date), partially paid, or unpaid.',
        'The ageing chart covers everything still owed today, whatever the invoice date.',
      ],
    };
  },
};

async function ageingBuckets(env: RunEnv) {
  const rows = await env.tx.$queryRaw<{ bucket: string; amount: bigint; n: number }[]>(Prisma.sql`
    SELECT ${bucketSql('i.due_date', env.today)} AS bucket, COALESCE(SUM(i.outstanding_cents),0)::bigint AS amount, COUNT(*)::int AS n
      FROM invoices i
     WHERE i.business_id = ${env.ctx.business.id}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.written_off_at IS NULL AND i.outstanding_cents > 0
       ${env.loc('i')} ${custIn(env, 'i')}
     GROUP BY 1`);
  const out = Object.fromEntries(AGE_BUCKETS.map((b) => [b, { amount: 0, count: 0 }])) as Record<(typeof AGE_BUCKETS)[number], { amount: number; count: number }>;
  for (const r of rows) out[r.bucket as keyof typeof out] = { amount: n(r.amount), count: r.n };
  return out;
}

// ───────────────────────── payments ─────────────────────────

const METHODS = ['ONLINE', 'CARD', 'EFT', 'CASH', 'OTHER'] as const;
const METHOD_LABEL: Record<string, string> = { ONLINE: 'Online', CARD: 'Card', EFT: 'EFT', CASH: 'Cash', OTHER: 'Other' };

export const payments: ReportDef = {
  key: 'payments', title: 'Payments', category: 'financial', dated: true, paged: true, sensitive: true,
  description: 'Money received by method, refunds, customer credit and what is still owed. Payments received are not the same as invoice value.',
  permissions: ['finance.view_reports', 'payment.view'], filters: ['range', 'location', 'customer', 'paymentMethod'],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const method = params.paymentMethod ? Prisma.sql`AND p.method = ${params.paymentMethod}::payment_method` : Prisma.empty;
    const base = Prisma.sql`
      FROM payments p JOIN customers c ON c.id = p.customer_id AND c.business_id = p.business_id LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id
     WHERE p.business_id = ${bid}::uuid AND p.status IN ${PAID_STATUSES} AND p.paid_at >= ${range.start} AND p.paid_at < ${range.end}
       ${env.loc('i')} ${custIn(env, 'p')} ${method}`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; number: string; paid_on: Date; customer_id: string; customer: string; invoice_id: string | null; invoice: string | null; method: string; amount: number; applied: number; credited: number; refunded: number; status: string }[]>(Prisma.sql`
      SELECT p.id, p.number, ${localDate('p.paid_at', tz)} AS paid_on, c.id AS customer_id, c.name AS customer, p.invoice_id, i.number AS invoice, p.method::text AS method, p.amount_cents AS amount,
             p.applied_cents AS applied, p.credited_cents AS credited, (p.refunded_applied_cents + p.refunded_credit_cents) AS refunded, p.status::text AS status ${base}
       ORDER BY p.paid_at DESC, p.number DESC LIMIT ${limit} OFFSET ${offset}`);
    const by = await tx.$queryRaw<{ method: string; n: number; amount: bigint }[]>(Prisma.sql`
      SELECT p.method::text AS method, COUNT(*)::int AS n, COALESCE(SUM(p.amount_cents),0)::bigint AS amount ${base} GROUP BY p.method`);
    const refunds = await tx.$queryRaw<{ n: number; amount: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(r.amount_cents),0)::bigint AS amount
        FROM refunds r JOIN payments p ON p.id = r.payment_id AND p.business_id = r.business_id LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id
       WHERE r.business_id = ${bid}::uuid AND r.refunded_at >= ${range.start} AND r.refunded_at < ${range.end} ${env.loc('i')} ${custIn(env, 'r')}
         ${params.paymentMethod ? Prisma.sql`AND p.method = ${params.paymentMethod}::payment_method` : Prisma.empty}`);
    const credit = await tx.$queryRaw<{ issued: bigint; applied: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN e.kind IN ('DEPOSIT','OVERPAYMENT','CREDIT_NOTE') THEN e.amount_cents ELSE 0 END),0)::bigint AS issued,
             COALESCE(SUM(CASE WHEN e.kind = 'APPLIED' THEN -e.amount_cents ELSE 0 END),0)::bigint AS applied
        FROM customer_credit_entries e WHERE e.business_id = ${bid}::uuid AND e.created_at >= ${range.start} AND e.created_at < ${range.end} ${custIn(env, 'e')}`);
    const open = await ageingBuckets(env);
    const outstanding = AGE_BUCKETS.reduce((a, b) => a + open[b].amount, 0);
    const received = by.reduce((a, r) => a + n(r.amount), 0);
    const count = by.reduce((a, r) => a + r.n, 0);
    const m = (k: string) => by.find((r) => r.method === k);
    return {
      columns: [
        col('number', 'Payment', 'text', { link: { path: '/payments', idKey: 'id' } }), col('paidAt', 'Date', 'date'), col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }),
        col('invoice', 'Invoice', 'text', { link: { path: '/invoices', idKey: 'invoiceId' } }), col('method', 'Method', 'text'), col('amount', 'Amount', 'money'),
        col('applied', 'Against invoice', 'money'), col('credited', 'To customer credit', 'money'), col('refunded', 'Refunded', 'money'),
      ],
      rows: rows.map((r) => ({ id: r.id, number: r.number, paidAt: isoDay(r.paid_on), customerId: r.customer_id, customer: r.customer, invoiceId: r.invoice_id, invoice: r.invoice, method: METHOD_LABEL[r.method] ?? r.method, amount: r.amount, applied: r.applied, credited: r.credited, refunded: r.refunded })),
      total: count,
      summary: [
        { key: 'received', label: 'Payments received', value: received, type: 'money', hint: `${count} payment${count === 1 ? '' : 's'}` },
        ...METHODS.map((k) => ({ key: `m_${k}`, label: METHOD_LABEL[k]!, value: n(m(k)?.amount), type: 'money' as const, hint: `${m(k)?.n ?? 0} payment${(m(k)?.n ?? 0) === 1 ? '' : 's'}` })),
        { key: 'refunds', label: 'Refunds paid', value: n(refunds[0]?.amount), type: 'money', hint: `${refunds[0]?.n ?? 0} refund${(refunds[0]?.n ?? 0) === 1 ? '' : 's'}` },
        { key: 'creditIssued', label: 'Customer credit created', value: n(credit[0]?.issued), type: 'money', hint: 'Deposits, overpayments and credit notes' },
        { key: 'creditApplied', label: 'Customer credit used on invoices', value: n(credit[0]?.applied), type: 'money' },
        { key: 'outstanding', label: 'Still owed today', value: outstanding, type: 'money', tone: outstanding > 0 ? 'warn' : undefined },
      ],
      charts: [bar('Payments received by method', 'money', METHODS.map((k) => METHOD_LABEL[k]!), [{ name: 'Received', values: METHODS.map((k) => n(m(k)?.amount)) }])],
      notes: ['Payments are shown on the day they completed. They are cash received, not invoiced revenue.', 'Location comes from the invoice a payment was made against; a deposit with no invoice has no location.'],
    };
  },
};

// ───────────────────────── receivables ─────────────────────────

export const receivables: ReportDef = {
  key: 'receivables', title: 'Outstanding receivables', category: 'financial', dated: false, paged: true, sensitive: true,
  description: 'Who owes what right now, aged by due date: current, 1–30, 31–60, 61–90 and 90+ days overdue.',
  permissions: ['finance.view_reports', 'invoice.view'], filters: ['location', 'customer', 'bucket'],
  async run(env) {
    const { tx, ctx, params, today } = env;
    const bid = ctx.business.id;
    const bucket = bucketSql('i.due_date', today);
    const bucketFilter = params.bucket ? Prisma.sql`WHERE q.bucket = ${params.bucket}` : Prisma.empty;
    const base = Prisma.sql`
      FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id LEFT JOIN vehicles v ON v.id = i.vehicle_id AND v.business_id = i.business_id
     WHERE i.business_id = ${bid}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.written_off_at IS NULL AND i.outstanding_cents > 0
       ${env.loc('i')} ${custIn(env, 'i')}`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; number: string; due_date: Date | null; invoice_date: Date | null; customer_id: string; customer: string; vehicle_id: string | null; registration: string | null; total: number; outstanding: number; bucket: string; late: number | null }[]>(Prisma.sql`
      SELECT * FROM (SELECT i.id, i.number, i.due_date, i.invoice_date, c.id AS customer_id, c.name AS customer, v.id AS vehicle_id, v.registration, i.total_cents AS total, i.outstanding_cents AS outstanding,
             ${bucket} AS bucket, (${today}::date - i.due_date) AS late ${base}) q ${bucketFilter} ORDER BY q.due_date ASC NULLS LAST, q.number ASC LIMIT ${limit} OFFSET ${offset}`);
    const agg = await tx.$queryRaw<{ bucket: string; n: number; amount: bigint }[]>(Prisma.sql`
      SELECT q.bucket, COUNT(*)::int AS n, COALESCE(SUM(q.outstanding),0)::bigint AS amount FROM (SELECT i.outstanding_cents AS outstanding, ${bucket} AS bucket ${base}) q GROUP BY q.bucket`);
    const g = (b: string) => agg.find((a) => a.bucket === b);
    const total = agg.reduce((a, r) => a + n(r.amount), 0);
    const overdue = agg.filter((a) => a.bucket !== 'current').reduce((a, r) => a + n(r.amount), 0);
    const count = params.bucket ? (g(params.bucket)?.n ?? 0) : agg.reduce((a, r) => a + r.n, 0);
    return {
      columns: [
        col('number', 'Invoice', 'text', { link: { path: '/invoices', idKey: 'id' } }), col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }),
        col('registration', 'Vehicle', 'text', { link: { path: '/vehicles', idKey: 'vehicleId' } }), col('invoiceDate', 'Invoice date', 'date'), col('dueDate', 'Due date', 'date'),
        col('daysOverdue', 'Days overdue', 'int'), col('ageing', 'Ageing', 'status'), col('total', 'Invoice total', 'money'), col('outstanding', 'Outstanding', 'money'),
      ],
      rows: rows.map((r) => ({ id: r.id, number: r.number, customerId: r.customer_id, customer: r.customer, vehicleId: r.vehicle_id, registration: r.registration, invoiceDate: isoDay(r.invoice_date), dueDate: isoDay(r.due_date), daysOverdue: Math.max(0, r.late ?? 0), ageing: BUCKET_LABEL[r.bucket] ?? r.bucket, total: r.total, outstanding: r.outstanding })),
      total: count,
      summary: [
        { key: 'total', label: 'Total outstanding', value: total, type: 'money' },
        { key: 'overdue', label: 'Overdue', value: overdue, type: 'money', tone: overdue > 0 ? 'danger' : undefined },
        ...AGE_BUCKETS.map((b) => ({ key: `b_${b}`, label: BUCKET_LABEL[b]!, value: n(g(b)?.amount), type: 'money' as const, hint: `${g(b)?.n ?? 0} invoice${(g(b)?.n ?? 0) === 1 ? '' : 's'}` })),
      ],
      charts: [bar('Outstanding by age', 'money', AGE_BUCKETS.map((b) => BUCKET_LABEL[b]!), [{ name: 'Outstanding', values: AGE_BUCKETS.map((b) => n(g(b)?.amount)) }])],
      notes: ['As of today. Not yet due, or due today, counts as current. Written-off and cancelled invoices are not receivables.'],
    };
  },
};

// ───────────────────────── quotes ─────────────────────────

export const quotes: ReportDef = {
  key: 'quotes', title: 'Quotes', category: 'financial', dated: true, paged: true, sensitive: true, feature: 'advanced_reports',
  description: 'Quote volume and value by outcome, approval and decline rates.',
  permissions: ['finance.view_reports', 'quote.view'], filters: ['range', 'location', 'customer', 'technician', 'serviceType', 'quoteStatus'],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const needsJob = params.technicianId || params.serviceTypeId;
    const base = Prisma.sql`
      FROM quotes q JOIN customers c ON c.id = q.customer_id AND c.business_id = q.business_id
      ${needsJob ? Prisma.sql`JOIN job_cards j ON j.id = q.job_id AND j.business_id = q.business_id ${params.technicianId ? Prisma.sql`AND j.primary_technician_membership_id = ${params.technicianId}::uuid` : Prisma.empty} ${params.serviceTypeId ? Prisma.sql`AND j.service_type_id = ${params.serviceTypeId}::uuid` : Prisma.empty}` : Prisma.empty}
     WHERE q.business_id = ${bid}::uuid AND q.quote_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${env.loc('q')} ${custIn(env, 'q')}`;
    const statusF = params.quoteStatus ? Prisma.sql`AND q.status = ${params.quoteStatus}::quote_status` : Prisma.empty;
    const agg = await tx.$queryRaw<{ status: string; n: number; total: bigint }[]>(Prisma.sql`SELECT q.status::text AS status, COUNT(*)::int AS n, COALESCE(SUM(q.total_cents),0)::bigint AS total ${base} GROUP BY q.status`);
    const { limit, offset } = pageOf(env);
    const list = await tx.$queryRaw<{ id: string; number: string; quote_date: Date | null; valid_until: Date | null; customer_id: string; customer: string; status: string; total: number }[]>(Prisma.sql`
      SELECT q.id, q.number, q.quote_date, q.valid_until, c.id AS customer_id, c.name AS customer, q.status::text AS status, q.total_cents AS total ${base} ${statusF}
       ORDER BY q.quote_date DESC NULLS LAST, q.number DESC LIMIT ${limit} OFFSET ${offset}`);
    const cnt = (s: string) => agg.find((a) => a.status === s)?.n ?? 0;
    const val = (s: string) => n(agg.find((a) => a.status === s)?.total);
    const approved = cnt('APPROVED') + cnt('CONVERTED');
    const sentEver = cnt('SENT') + cnt('VIEWED') + approved + cnt('DECLINED') + cnt('EXPIRED');
    const total = agg.reduce((a, r) => a + r.n, 0);
    const sentValue = val('SENT') + val('VIEWED') + val('APPROVED') + val('CONVERTED') + val('DECLINED') + val('EXPIRED');
    const STATUSES = ['DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'];
    const LABEL: Record<string, string> = { DRAFT: 'Draft', SENT: 'Sent', VIEWED: 'Viewed', APPROVED: 'Approved', DECLINED: 'Declined', EXPIRED: 'Expired', CONVERTED: 'Converted to invoice', CANCELLED: 'Cancelled' };
    return {
      columns: [
        col('number', 'Quote', 'text', { link: { path: '/quotes', idKey: 'id' } }), col('quoteDate', 'Date', 'date'), col('validUntil', 'Valid until', 'date'),
        col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }), col('status', 'Status', 'status'), col('total', 'Total (incl. VAT)', 'money'),
      ],
      rows: list.map((r) => ({ id: r.id, number: r.number, quoteDate: isoDay(r.quote_date), validUntil: isoDay(r.valid_until), customerId: r.customer_id, customer: r.customer, status: LABEL[r.status] ?? r.status, total: r.total })),
      total: params.quoteStatus ? cnt(params.quoteStatus) : total,
      summary: [
        { key: 'count', label: 'Quotes', value: total, type: 'int' },
        { key: 'value', label: 'Quote value (incl. VAT)', value: agg.reduce((a, r) => a + n(r.total), 0), type: 'money' },
        ...STATUSES.map((s) => ({ key: `s_${s}`, label: LABEL[s]!, value: cnt(s), type: 'int' as const, hint: s === 'DRAFT' || s === 'CANCELLED' ? undefined : undefined })),
        { key: 'approvalRate', label: 'Approval rate', value: pct(approved, sentEver), type: 'pct', hint: 'Of quotes sent to customers' },
        { key: 'declineRate', label: 'Decline rate', value: pct(cnt('DECLINED'), sentEver), type: 'pct' },
        { key: 'average', label: 'Average quote value', value: sentEver ? Math.round(sentValue / sentEver) : null, type: 'money', hint: 'Of quotes sent' },
        { key: 'approvedValue', label: 'Approved value', value: val('APPROVED') + val('CONVERTED'), type: 'money' },
      ],
      charts: [bar('Quotes by outcome', 'int', STATUSES.map((s) => LABEL[s]!), [{ name: 'Quotes', values: STATUSES.map((s) => cnt(s)) }])],
      notes: ['Rates are of quotes that were sent: approved or converted, declined, expired, or still open.', 'Technician and service filters use the job the quote belongs to; quotes with no job are excluded when either is chosen.'],
    };
  },
};

export const FINANCIAL: ReportDef[] = [revenue, invoices, payments, receivables, quotes];
void nn;
