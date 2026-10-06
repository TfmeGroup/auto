import { Prisma } from '@/server/db/client';
import { dateOnly } from '@/server/finance/common';
import { bar, col, fillPeriods, isoDay, localDate, n, pageOf, pct, periodLabel, UNIT_GROUPS, unitSql, type Unit } from './util';
import type { ReportDef, RunEnv } from '../types';

/**
 * Operational gross profitability:  revenue - parts cost - labour cost = gross profit.
 * Revenue is invoiced (VAT excluded) on issued invoices in the period. Costs are the costs copied onto each invoice line when the line
 * was created (a part's cost price, a technician's cost rate x hours), so a later price or rate change never rewrites history.
 * Lines with no recorded cost are counted as zero cost and reported. It is NOT net profit and not accounts: overheads, wages beyond
 * recorded labour cost, tax and everything else are not in it.
 */

const COST = Prisma.sql`CASE WHEN l.unit_cost_cents IS NOT NULL THEN ROUND(l.quantity_milli::numeric * l.unit_cost_cents / 1000) ELSE 0 END`;

export const profitability: ReportDef = {
  key: 'profitability', title: 'Profitability', category: 'profitability', dated: true, paged: true, feature: 'financial_reports', sensitive: true,
  description: 'Operational gross profit: revenue less parts cost less labour cost, by service, job or period.',
  permissions: ['finance.view_reports', 'finance.view_costs'], filters: ['range', 'location', 'customer', 'technician', 'serviceType'],
  groupBys: [{ key: 'service', label: 'By service' }, { key: 'job', label: 'By job' }, ...UNIT_GROUPS],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const group = params.groupBy ?? 'service';
    const unit: Unit | null = group === 'day' || group === 'week' || group === 'month' ? group : null;
    const joins = Prisma.sql`FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.business_id = l.business_id LEFT JOIN job_cards j ON j.id = i.job_id AND j.business_id = i.business_id`;
    const where = Prisma.sql`l.business_id = ${bid}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)}
      ${env.loc('i')} ${env.eq('i.customer_id', params.customerId, 'uuid')} ${env.eq('j.service_type_id', params.serviceTypeId, 'uuid')}
      ${params.technicianId ? Prisma.sql`AND j.primary_technician_membership_id = ${params.technicianId}::uuid` : Prisma.empty}`;
    const agg = Prisma.sql`COALESCE(SUM(l.taxable_cents),0)::bigint AS revenue,
      COALESCE(SUM(${COST}) FILTER (WHERE l.line_type = 'PART'),0)::bigint AS parts_cost, COALESCE(SUM(${COST}) FILTER (WHERE l.line_type = 'LABOUR'),0)::bigint AS labour_cost,
      COALESCE(SUM(${COST}) FILTER (WHERE l.line_type NOT IN ('PART','LABOUR')),0)::bigint AS other_cost, COUNT(*) FILTER (WHERE l.unit_cost_cents IS NULL AND l.line_type IN ('PART','LABOUR'))::int AS uncosted`;
    type A = { revenue: bigint; parts_cost: bigint; labour_cost: bigint; other_cost: bigint; uncosted: number };
    const total = (await tx.$queryRaw<(A & { jobs: number })[]>(Prisma.sql`SELECT ${agg}, COUNT(DISTINCT i.job_id)::int AS jobs ${joins} WHERE ${where}`))[0]!;
    const credits = (await tx.$queryRaw<{ ex: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(c.taxable_cents),0)::bigint AS ex FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id LEFT JOIN job_cards j ON j.id = i.job_id AND j.business_id = i.business_id
       WHERE c.business_id = ${bid}::uuid AND c.status = 'ISSUED' AND c.issued_at >= ${range.start} AND c.issued_at < ${range.end} ${env.loc('i')} ${env.eq('i.customer_id', params.customerId, 'uuid')} ${env.eq('j.service_type_id', params.serviceTypeId, 'uuid')}
       ${params.technicianId ? Prisma.sql`AND j.primary_technician_membership_id = ${params.technicianId}::uuid` : Prisma.empty}`))[0]!;
    const calc = (a: { revenue: unknown; parts_cost: unknown; labour_cost: unknown; other_cost: unknown }) => {
      const revenue = n(a.revenue), parts = n(a.parts_cost), labour = n(a.labour_cost), other = n(a.other_cost);
      return { revenue, parts, labour, other, profit: revenue - parts - labour - other };
    };
    const T = calc(total);
    const summary = [
      { key: 'revenue', label: 'Revenue (ex VAT)', value: T.revenue, type: 'money' as const },
      { key: 'partsCost', label: 'Parts cost', value: T.parts, type: 'money' as const },
      { key: 'labourCost', label: 'Labour cost', value: T.labour, type: 'money' as const },
      ...(T.other ? [{ key: 'otherCost', label: 'Other recorded cost', value: T.other, type: 'money' as const }] : []),
      { key: 'profit', label: 'Gross profit', value: T.profit, type: 'money' as const, tone: T.profit < 0 ? ('danger' as const) : undefined },
      { key: 'margin', label: 'Gross margin', value: pct(T.profit, T.revenue), type: 'pct' as const },
      { key: 'credits', label: 'Credit notes issued (ex VAT)', value: n(credits.ex), type: 'money' as const, hint: 'Shown for information; not taken off the figures above' },
      { key: 'uncosted', label: 'Part and labour lines with no cost recorded', value: total.uncosted, type: 'int' as const, tone: total.uncosted > 0 ? ('warn' as const) : undefined, hint: 'Counted as zero cost' },
    ];
    const notes = [
      'Gross profit = revenue (invoiced, ex VAT) less the parts and labour cost recorded on those invoice lines. It is not net profit and is not accounting: overheads, wages beyond recorded labour cost and tax are not included.',
      'Costs were copied onto each line when it was created, so changing a price or rate later never rewrites earlier work.',
    ];
    const { limit, offset } = pageOf(env);
    const row = (label: string, a: A, extra: Record<string, unknown> = {}) => { const c = calc(a); return { group: label, ...extra, revenue: c.revenue, partsCost: c.parts, labourCost: c.labour, grossProfit: c.profit, margin: pct(c.profit, c.revenue) }; };

    if (group === 'job') {
      const rows = await tx.$queryRaw<(A & { id: string | null; job_number: string | null; customer_id: string | null; customer: string | null; vehicle_id: string | null; registration: string | null })[]>(Prisma.sql`
        SELECT j.id, j.job_number, c.id AS customer_id, c.name AS customer, v.id AS vehicle_id, v.registration, ${agg}
          ${joins} LEFT JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id LEFT JOIN vehicles v ON v.id = i.vehicle_id AND v.business_id = i.business_id
         WHERE ${where} AND i.job_id IS NOT NULL GROUP BY j.id, j.job_number, c.id, c.name, v.id, v.registration ORDER BY SUM(l.taxable_cents) DESC LIMIT ${limit} OFFSET ${offset}`);
      const cnt = (await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(DISTINCT i.job_id)::int AS n ${joins} WHERE ${where} AND i.job_id IS NOT NULL`))[0]!.n;
      return {
        columns: [col('group', 'Job', 'text', { link: { path: '/jobs', idKey: 'id' } }), col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }), col('registration', 'Vehicle', 'text', { link: { path: '/vehicles', idKey: 'vehicleId' } }),
          col('revenue', 'Revenue (ex VAT)', 'money'), col('partsCost', 'Parts cost', 'money'), col('labourCost', 'Labour cost', 'money'), col('grossProfit', 'Gross profit', 'money'), col('margin', 'Gross margin', 'pct')],
        rows: rows.map((r) => ({ ...row(r.job_number ?? '—', r), id: r.id, customerId: r.customer_id, customer: r.customer, vehicleId: r.vehicle_id, registration: r.registration })),
        total: cnt, summary, notes,
      };
    }
    const key = group === 'service' ? Prisma.sql`COALESCE(j.service_label, 'No job / service')` : Prisma.sql`date_trunc(${unitSql(unit ?? 'month')}, i.invoice_date)::date::text`;
    const rows = await tx.$queryRaw<(A & { k: string; jobs: number })[]>(Prisma.sql`SELECT ${key} AS k, COUNT(DISTINCT i.job_id)::int AS jobs, ${agg} ${joins} WHERE ${where} GROUP BY 1 ORDER BY ${unit ? Prisma.sql`1` : Prisma.sql`SUM(l.taxable_cents) DESC`} LIMIT 500`);
    type R = ReturnType<typeof row> & { jobs: number };
    let data: R[] = rows.map((r) => ({ ...row(r.k, r, { jobs: r.jobs }), jobs: r.jobs }));
    if (unit) {
      const filled = fillPeriods(env as RunEnv, unit, data.map((d) => ({ ...d, period: d.group })), (p) => ({ period: p, group: p, jobs: 0, revenue: 0, partsCost: 0, labourCost: 0, grossProfit: 0, margin: null }) as R & { period: string });
      data = filled.map((d) => ({ ...d, group: periodLabel(d.period, unit) }));
    }
    return {
      columns: [col('group', group === 'service' ? 'Service' : unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month', 'text'), col('jobs', 'Jobs', 'int'), col('revenue', 'Revenue (ex VAT)', 'money'),
        col('partsCost', 'Parts cost', 'money'), col('labourCost', 'Labour cost', 'money'), col('grossProfit', 'Gross profit', 'money'), col('margin', 'Gross margin', 'pct')],
      rows: data, total: data.length, summary,
      charts: [bar(group === 'service' ? 'Gross profit by service' : 'Revenue and gross profit', 'money', data.map((r) => r.group), [{ name: 'Revenue (ex VAT)', values: data.map((r) => r.revenue) }, { name: 'Gross profit', values: data.map((r) => r.grossProfit) }], unit ? 'line' : 'bar')],
      notes,
    };
  },
};

// ───────────────────────── VAT (operational) ─────────────────────────

export const vat: ReportDef = {
  key: 'vat', title: 'VAT (operational)', category: 'vat', dated: true, paged: true, feature: 'advanced_reports', sensitive: true,
  description: 'Taxable sales and VAT on issued invoices and credit notes, with each document. Operational data for your accountant, not a VAT return.',
  permissions: ['finance.view_reports'], filters: ['range', 'location', 'customer'],
  groupBys: [{ key: 'rate', label: 'By rate and treatment' }, { key: 'documents', label: 'Each document' }],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const group = params.groupBy ?? 'rate';
    const invWhere = Prisma.sql`i.business_id = ${bid}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${env.loc('i')} ${env.eq('i.customer_id', params.customerId, 'uuid')}`;
    const cnWhere = Prisma.sql`c.business_id = ${bid}::uuid AND c.status = 'ISSUED' AND c.issued_at >= ${range.start} AND c.issued_at < ${range.end} ${env.loc('i')} ${env.eq('c.customer_id', params.customerId, 'uuid')}`;
    const t = (await tx.$queryRaw<{ i_taxable: bigint; i_vat: bigint; c_taxable: bigint; c_vat: bigint; i_n: number; c_n: number }[]>(Prisma.sql`
      SELECT (SELECT COALESCE(SUM(i.taxable_cents),0) FROM invoices i WHERE ${invWhere})::bigint AS i_taxable, (SELECT COALESCE(SUM(i.vat_cents),0) FROM invoices i WHERE ${invWhere})::bigint AS i_vat,
             (SELECT COALESCE(SUM(c.taxable_cents),0) FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id WHERE ${cnWhere})::bigint AS c_taxable,
             (SELECT COALESCE(SUM(c.vat_cents),0) FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id WHERE ${cnWhere})::bigint AS c_vat,
             (SELECT COUNT(*)::int FROM invoices i WHERE ${invWhere}) AS i_n, (SELECT COUNT(*)::int FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id WHERE ${cnWhere}) AS c_n`))[0]!;
    const summary = [
      { key: 'taxable', label: 'Taxable sales (net of credit notes)', value: n(t.i_taxable) - n(t.c_taxable), type: 'money' as const },
      { key: 'vatCollected', label: 'VAT collected on invoices', value: n(t.i_vat), type: 'money' as const, hint: `${t.i_n} invoice${t.i_n === 1 ? '' : 's'}` },
      { key: 'creditVat', label: 'VAT on credit notes', value: n(t.c_vat), type: 'money' as const, hint: `${t.c_n} credit note${t.c_n === 1 ? '' : 's'}` },
      { key: 'netVat', label: 'Net VAT', value: n(t.i_vat) - n(t.c_vat), type: 'money' as const },
    ];
    const notes = [
      ctx.business.vatRegistered ? 'Operational VAT data from issued invoices (by invoice date) and credit notes (by date issued), using the VAT rate and treatment recorded on each document at the time. It is not a VAT return.'
        : 'This business is not marked as VAT registered, so documents carry no VAT. The figures below are sales only.',
      'Shown for your accountant. TFME Auto does not file or calculate your statutory VAT return.',
    ];
    if (group === 'documents') {
      const { limit, offset } = pageOf(env);
      const rows = await tx.$queryRaw<{ id: string; doc: string; number: string | null; day: Date; customer_id: string; customer: string; taxable: number; vat: number; total: number }[]>(Prisma.sql`
        SELECT * FROM (
          SELECT i.id, 'Invoice' AS doc, i.number, i.invoice_date AS day, i.customer_id, c.name AS customer, i.taxable_cents AS taxable, i.vat_cents AS vat, i.total_cents AS total
            FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id WHERE ${invWhere}
          UNION ALL
          SELECT c.id, 'Credit note', c.number, ${localDate('c.issued_at', tz)}, c.customer_id, cu.name, -c.taxable_cents, -c.vat_cents, -c.total_cents
            FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id WHERE ${cnWhere}
        ) u ORDER BY u.day DESC, u.number DESC LIMIT ${limit} OFFSET ${offset}`);
      return {
        columns: [col('doc', 'Document', 'text'), col('number', 'Number', 'text'), col('day', 'Date', 'date'), col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }), col('taxable', 'Taxable amount', 'money'), col('vat', 'VAT', 'money'), col('total', 'Total', 'money')],
        rows: rows.map((r) => ({ id: r.id, doc: r.doc, number: r.number, day: isoDay(r.day), customerId: r.customer_id, customer: r.customer, taxable: r.taxable, vat: r.vat, total: r.total })),
        total: t.i_n + t.c_n, summary, notes,
      };
    }
    const lineRows = async (docs: 'i' | 'c') => tx.$queryRaw<{ treatment: string; rate: number; taxable: bigint; vat: bigint; n: number }[]>(docs === 'i' ? Prisma.sql`
      SELECT l.tax_treatment::text AS treatment, l.vat_rate_bps AS rate, COALESCE(SUM(l.taxable_cents),0)::bigint AS taxable, COALESCE(SUM(l.vat_cents),0)::bigint AS vat, COUNT(DISTINCT i.id)::int AS n
        FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.business_id = l.business_id WHERE ${invWhere} GROUP BY 1, 2 ORDER BY 2 DESC` : Prisma.sql`
      SELECT l.tax_treatment::text AS treatment, l.vat_rate_bps AS rate, COALESCE(SUM(l.taxable_cents),0)::bigint AS taxable, COALESCE(SUM(l.vat_cents),0)::bigint AS vat, COUNT(DISTINCT c.id)::int AS n
        FROM credit_note_lines l JOIN credit_notes c ON c.id = l.credit_note_id AND c.business_id = l.business_id JOIN invoices i ON i.id = c.invoice_id AND i.business_id = c.business_id WHERE ${cnWhere} GROUP BY 1, 2 ORDER BY 2 DESC`);
    const [inv, cn] = [await lineRows('i'), await lineRows('c')];
    const TREAT: Record<string, string> = { STANDARD: 'Standard rate', ZERO_RATED: 'Zero-rated', EXEMPT: 'Exempt' };
    const rows = [
      ...inv.map((r) => ({ source: 'Invoices', treatment: TREAT[r.treatment] ?? r.treatment, rate: r.rate / 100, documents: r.n, taxable: n(r.taxable), vat: n(r.vat) })),
      ...cn.map((r) => ({ source: 'Credit notes', treatment: TREAT[r.treatment] ?? r.treatment, rate: r.rate / 100, documents: r.n, taxable: -n(r.taxable), vat: -n(r.vat) })),
    ];
    return {
      columns: [col('source', 'From', 'text'), col('treatment', 'VAT treatment', 'text'), col('rate', 'Rate (%)', 'int'), col('documents', 'Documents', 'int'), col('taxable', 'Taxable amount', 'money'), col('vat', 'VAT', 'money')],
      rows, summary, notes,
    };
  },
};

// ───────────────────────── accounting export ─────────────────────────

export const accounting: ReportDef = {
  key: 'accounting', title: 'Accounting export', category: 'vat', dated: true, paged: true, feature: 'advanced_reports', sensitive: true,
  description: 'Clean rows of invoices, credit notes, payments and refunds with dates, references, amounts and VAT, for your accountant or bookkeeping software.',
  permissions: ['finance.view_reports', 'finance.export'], filters: ['range', 'location', 'customer', 'docType'],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const want = (t: string) => !params.docType || params.docType === t;
    const parts: Prisma.Sql[] = [];
    if (want('INVOICE')) parts.push(Prisma.sql`
      SELECT 'INVOICE' AS doc, i.id::text AS id, i.invoice_date AS day, i.number AS reference, c.customer_number, c.name AS customer, i.taxable_cents AS net, i.vat_cents AS vat, i.total_cents AS gross, NULL::text AS method, NULL::text AS related
        FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id
       WHERE i.business_id = ${bid}::uuid AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${env.loc('i')} ${env.eq('i.customer_id', params.customerId, 'uuid')}`);
    if (want('CREDIT_NOTE')) parts.push(Prisma.sql`
      SELECT 'CREDIT_NOTE', cn.id::text, ${localDate('cn.issued_at', tz)}, cn.number, c.customer_number, c.name, -cn.taxable_cents, -cn.vat_cents, -cn.total_cents, NULL::text, i.number
        FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id AND i.business_id = cn.business_id JOIN customers c ON c.id = cn.customer_id AND c.business_id = cn.business_id
       WHERE cn.business_id = ${bid}::uuid AND cn.status = 'ISSUED' AND cn.issued_at >= ${range.start} AND cn.issued_at < ${range.end} ${env.loc('i')} ${env.eq('cn.customer_id', params.customerId, 'uuid')}`);
    if (want('PAYMENT')) parts.push(Prisma.sql`
      SELECT 'PAYMENT', p.id::text, ${localDate('p.paid_at', tz)}, p.number, c.customer_number, c.name, p.amount_cents, 0, p.amount_cents, p.method::text, i.number
        FROM payments p JOIN customers c ON c.id = p.customer_id AND c.business_id = p.business_id LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id
       WHERE p.business_id = ${bid}::uuid AND p.status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED') AND p.paid_at >= ${range.start} AND p.paid_at < ${range.end} ${env.loc('i')} ${env.eq('p.customer_id', params.customerId, 'uuid')}`);
    if (want('REFUND')) parts.push(Prisma.sql`
      SELECT 'REFUND', r.id::text, ${localDate('r.refunded_at', tz)}, r.number, c.customer_number, c.name, -r.amount_cents, 0, -r.amount_cents, p.method::text, i.number
        FROM refunds r JOIN payments p ON p.id = r.payment_id AND p.business_id = r.business_id JOIN customers c ON c.id = r.customer_id AND c.business_id = r.business_id LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id
       WHERE r.business_id = ${bid}::uuid AND r.refunded_at >= ${range.start} AND r.refunded_at < ${range.end} ${env.loc('i')} ${env.eq('r.customer_id', params.customerId, 'uuid')}`);
    const u = Prisma.sql`(${Prisma.join(parts, ' UNION ALL ')})`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ doc: string; id: string; day: Date; reference: string | null; customer_number: string; customer: string; net: number; vat: number; gross: number; method: string | null; related: string | null }[]>(Prisma.sql`
      SELECT * FROM ${u} u(doc, id, day, reference, customer_number, customer, net, vat, gross, method, related) ORDER BY day DESC, doc, reference DESC LIMIT ${limit} OFFSET ${offset}`);
    const agg = await tx.$queryRaw<{ doc: string; n: number; net: bigint; vat: bigint; gross: bigint }[]>(Prisma.sql`
      SELECT doc, COUNT(*)::int AS n, COALESCE(SUM(net),0)::bigint AS net, COALESCE(SUM(vat),0)::bigint AS vat, COALESCE(SUM(gross),0)::bigint AS gross FROM ${u} u(doc, id, day, reference, customer_number, customer, net, vat, gross, method, related) GROUP BY doc`);
    const LABEL: Record<string, string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', PAYMENT: 'Payment', REFUND: 'Refund' };
    return {
      columns: [col('date', 'Date', 'date'), col('type', 'Type', 'text'), col('reference', 'Reference', 'text'), col('customerNumber', 'Customer no.', 'text'), col('customer', 'Customer', 'text'),
        col('relatedInvoice', 'Against invoice', 'text'), col('method', 'Method', 'text'), col('net', 'Amount ex VAT', 'money'), col('vat', 'VAT', 'money'), col('gross', 'Amount incl. VAT', 'money')],
      rows: rows.map((r) => ({ date: isoDay(r.day), type: LABEL[r.doc] ?? r.doc, reference: r.reference, customerNumber: r.customer_number, customer: r.customer, relatedInvoice: r.related, method: r.method ? r.method.toLowerCase() : null, net: r.net, vat: r.vat, gross: r.gross })),
      total: agg.reduce((a, r) => a + r.n, 0),
      summary: ['INVOICE', 'CREDIT_NOTE', 'PAYMENT', 'REFUND'].filter(want).map((k) => ({ key: k, label: `${LABEL[k]}s`, value: n(agg.find((a) => a.doc === k)?.gross), type: 'money' as const, hint: `${agg.find((a) => a.doc === k)?.n ?? 0} row${(agg.find((a) => a.doc === k)?.n ?? 0) === 1 ? '' : 's'}` })),
      notes: ['Credit notes and refunds are negative. Payments are the cash received on the day, and carry no VAT of their own: the VAT is on the invoice they pay.', 'These are clean rows for your accountant or bookkeeping software. TFME Auto is not an accounting system and has no live accounting integration.'],
    };
  },
};

export const PROFIT: ReportDef[] = [profitability, vat, accounting];
