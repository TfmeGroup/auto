import { Prisma } from '@/server/db/client';
import { dateOnly } from '@/server/finance/common';
import { bar, col, isoDay, localDate, n, pageOf, pct } from './util';
import type { ReportDef } from '../types';

/**
 * Supplier and purchase-order reports. Delivery performance is only worked out where an order has both an expected date and a recorded
 * delivery, and is blank otherwise: nothing about a supplier is estimated.
 */

const PO_LABEL: Record<string, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Awaiting approval', APPROVED: 'Approved', ORDERED: 'Ordered', PARTIALLY_RECEIVED: 'Partially received', RECEIVED: 'Received', CANCELLED: 'Cancelled' };
const PO_STATUSES = Object.keys(PO_LABEL);
/** Money committed to a supplier: orders that were actually placed. */
const PLACED = Prisma.sql`('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED')`;

export const suppliers: ReportDef = {
  key: 'suppliers', title: 'Suppliers', category: 'suppliers', dated: true, paged: true, feature: 'advanced_reports',
  description: 'Purchase orders, purchase value, parts received, returns and delivery performance for each supplier.',
  permissions: ['inventory.purchase'], filters: ['range', 'location', 'supplier'],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
    const { limit, offset } = pageOf(env);
    const poLoc = env.loc('po', { includeNull: false });
    const rows = await tx.$queryRaw<{ id: string; name: string; orders: number; value: bigint; units: bigint; last_order: Date | null; returns: number; returned_units: bigint; measured: number; on_time: number }[]>(Prisma.sql`
      SELECT s.id, s.name,
             (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id AND po.status IN ${PLACED} AND po.po_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${poLoc}) AS orders,
             (SELECT COALESCE(SUM(po.total_cents),0) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id AND po.status IN ${PLACED} AND po.po_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${poLoc})::bigint AS value,
             (SELECT COALESCE(SUM(rl.quantity_received),0) FROM goods_receipt_lines rl JOIN goods_receipts gr ON gr.id = rl.receipt_id AND gr.business_id = rl.business_id
               WHERE gr.supplier_id = s.id AND gr.business_id = s.business_id AND gr.received_at >= ${range.start} AND gr.received_at < ${range.end} ${env.loc('gr', { includeNull: false })})::bigint AS units,
             (SELECT MAX(po.po_date) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id AND po.status IN ${PLACED}) AS last_order,
             (SELECT COUNT(*)::int FROM supplier_returns sr WHERE sr.supplier_id = s.id AND sr.business_id = s.business_id AND sr.created_at >= ${range.start} AND sr.created_at < ${range.end} ${env.loc('sr', { includeNull: false })}) AS returns,
             (SELECT COALESCE(SUM(srl.quantity),0) FROM supplier_return_lines srl JOIN supplier_returns sr ON sr.id = srl.return_id AND sr.business_id = srl.business_id
               WHERE sr.supplier_id = s.id AND sr.business_id = s.business_id AND sr.created_at >= ${range.start} AND sr.created_at < ${range.end} ${env.loc('sr', { includeNull: false })})::bigint AS returned_units,
             (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id AND po.status = 'RECEIVED' AND po.expected_date IS NOT NULL AND po.po_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${poLoc}) AS measured,
             (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id AND po.status = 'RECEIVED' AND po.expected_date IS NOT NULL AND po.po_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${poLoc}
                AND (SELECT MAX(${localDate('gr.received_at', ctx.business.timezone)}) FROM goods_receipts gr WHERE gr.purchase_order_id = po.id AND gr.business_id = po.business_id) <= po.expected_date) AS on_time
        FROM suppliers s WHERE s.business_id = ${bid}::uuid AND s.status <> 'ARCHIVED' ${env.eq('s.id', params.supplierId, 'uuid')}
       ORDER BY value DESC, s.name LIMIT ${limit} OFFSET ${offset}`);
    const total = await tx.supplier.count({ where: { businessId: bid, status: { not: 'ARCHIVED' }, ...(params.supplierId ? { id: params.supplierId } : {}) } });
    const active = await tx.supplier.count({ where: { businessId: bid, status: 'ACTIVE' } });
    const sum = (k: 'orders' | 'value' | 'units' | 'returns') => rows.reduce((a, r) => a + n(r[k]), 0);
    const measured = rows.reduce((a, r) => a + r.measured, 0);
    const onTime = rows.reduce((a, r) => a + r.on_time, 0);
    return {
      columns: [
        col('name', 'Supplier', 'text'), col('orders', 'Orders placed', 'int'), col('perMonth', 'Orders per month', 'int'), col('value', 'Purchase value (incl. VAT)', 'money', { needs: 'inventory.view_costs' }),
        col('units', 'Parts received', 'int'), col('lastOrder', 'Last order', 'date'), col('returns', 'Returns', 'int'), col('returnedUnits', 'Units returned', 'int'), col('onTime', 'Delivered by expected date', 'pct'),
      ],
      rows: rows.map((r) => ({ name: r.name, orders: r.orders, perMonth: r.orders ? Math.round((r.orders / (days / 30.4)) * 10) / 10 : 0, value: n(r.value), units: n(r.units), lastOrder: isoDay(r.last_order), returns: r.returns, returnedUnits: n(r.returned_units), onTime: pct(r.on_time, r.measured) })),
      total,
      summary: [
        { key: 'suppliers', label: 'Suppliers', value: total, type: 'int', hint: `${active} active` },
        { key: 'orders', label: 'Orders placed', value: sum('orders'), type: 'int' },
        { key: 'value', label: 'Purchase value (incl. VAT)', value: sum('value'), type: 'money', needs: 'inventory.view_costs' },
        { key: 'units', label: 'Parts received', value: sum('units'), type: 'int' },
        { key: 'returns', label: 'Returns to suppliers', value: sum('returns'), type: 'int' },
        { key: 'onTime', label: 'Delivered by expected date', value: pct(onTime, measured), type: 'pct', hint: measured ? `Of ${measured} fully received order${measured === 1 ? '' : 's'} with an expected date` : 'No received order has an expected date yet' },
      ],
      charts: [bar('Purchase value by supplier', 'money', rows.slice(0, 12).map((r) => r.name), [{ name: 'Purchase value', values: rows.slice(0, 12).map((r) => n(r.value)), needs: 'inventory.view_costs' }])],
      notes: ['Orders placed means ordered, partly received or received (not drafts or cancelled orders). Delivery performance compares the last delivery with the expected date, only for fully received orders that had an expected date.'],
    };
  },
};

export const purchaseOrders: ReportDef = {
  key: 'purchase_orders', title: 'Purchase orders', category: 'suppliers', dated: true, paged: true, feature: 'purchase_orders',
  description: 'Purchase orders by status, total purchase value and what is still waiting to be delivered.',
  permissions: ['inventory.purchase'], filters: ['range', 'location', 'supplier', 'poStatus'],
  groupBys: [{ key: 'status', label: 'By status' }, { key: 'supplier', label: 'By supplier' }, { key: 'outstanding', label: 'Outstanding deliveries' }, { key: 'none', label: 'Each order' }],
  async run(env) {
    const { tx, ctx, range, params, today } = env;
    const bid = ctx.business.id;
    const group = params.groupBy ?? 'status';
    const base = Prisma.sql`po.business_id = ${bid}::uuid AND po.po_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)} ${env.loc('po', { includeNull: false })}
      ${env.eq('po.supplier_id', params.supplierId, 'uuid')} ${params.poStatus ? Prisma.sql`AND po.status = ${params.poStatus}::purchase_order_status` : Prisma.empty}`;
    const outstandingLines = Prisma.sql`(SELECT COALESCE(SUM(GREATEST(l.quantity_ordered - l.quantity_received - l.quantity_cancelled, 0)),0) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.business_id = po.business_id)`;
    const outstandingValue = Prisma.sql`(SELECT COALESCE(SUM(GREATEST(l.quantity_ordered - l.quantity_received - l.quantity_cancelled, 0) * l.unit_cost_cents),0) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.business_id = po.business_id)`;
    const by = await tx.$queryRaw<{ status: string; n: number; total: bigint }[]>(Prisma.sql`SELECT po.status::text AS status, COUNT(*)::int AS n, COALESCE(SUM(po.total_cents),0)::bigint AS total FROM purchase_orders po WHERE ${base} GROUP BY po.status`);
    const open = (await tx.$queryRaw<{ n: number; units: bigint; value: bigint; late: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(${outstandingLines}),0)::bigint AS units, COALESCE(SUM(${outstandingValue}),0)::bigint AS value,
             COUNT(*) FILTER (WHERE po.expected_date IS NOT NULL AND po.expected_date < ${today}::date)::int AS late
        FROM purchase_orders po WHERE ${base} AND po.status IN ('ORDERED','PARTIALLY_RECEIVED') AND ${outstandingLines} > 0`))[0]!;
    const cnt = (s: string) => by.find((r) => r.status === s)?.n ?? 0;
    const placed = by.filter((r) => ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(r.status)).reduce((a, r) => a + n(r.total), 0);
    const summary = [
      { key: 'count', label: 'Purchase orders', value: by.reduce((a, r) => a + r.n, 0), type: 'int' as const },
      ...['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'].map((s) => ({ key: `s_${s}`, label: PO_LABEL[s]!, value: cnt(s), type: 'int' as const })),
      { key: 'value', label: 'Total purchase value (incl. VAT)', value: placed, type: 'money' as const, needs: 'inventory.view_costs' as const, hint: 'Ordered, partly received and received' },
      { key: 'outstanding', label: 'Outstanding deliveries', value: open.n, type: 'int' as const, tone: open.late > 0 ? ('warn' as const) : undefined, hint: open.late ? `${open.late} past the expected date` : `${n(open.units)} units still to arrive` },
      { key: 'outstandingValue', label: 'Value still to be delivered (ex VAT)', value: n(open.value), type: 'money' as const, needs: 'inventory.view_costs' as const },
    ];
    const { limit, offset } = pageOf(env);
    const notes = ['Orders are counted by order date. Outstanding is ordered units not yet received or cancelled, on orders that are ordered or partly received.'];
    if (group === 'status') {
      return { columns: [col('status', 'Status', 'text'), col('orders', 'Orders', 'int'), col('value', 'Value (incl. VAT)', 'money', { needs: 'inventory.view_costs' })],
        rows: PO_STATUSES.map((s) => ({ status: PO_LABEL[s], orders: cnt(s), value: n(by.find((r) => r.status === s)?.total) })), summary,
        charts: [bar('Purchase orders by status', 'int', PO_STATUSES.map((s) => PO_LABEL[s]!), [{ name: 'Orders', values: PO_STATUSES.map((s) => cnt(s)) }])], notes };
    }
    if (group === 'supplier') {
      const rows = await tx.$queryRaw<{ name: string; n: number; total: bigint }[]>(Prisma.sql`SELECT s.name, COUNT(*)::int AS n, COALESCE(SUM(po.total_cents),0)::bigint AS total FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id AND s.business_id = po.business_id WHERE ${base} GROUP BY s.name ORDER BY total DESC LIMIT ${limit} OFFSET ${offset}`);
      return { columns: [col('supplier', 'Supplier', 'text'), col('orders', 'Orders', 'int'), col('value', 'Value (incl. VAT)', 'money', { needs: 'inventory.view_costs' })], rows: rows.map((r) => ({ supplier: r.name, orders: r.n, value: n(r.total) })), summary, notes };
    }
    const outstandingOnly = group === 'outstanding' ? Prisma.sql`AND po.status IN ('ORDERED','PARTIALLY_RECEIVED') AND ${outstandingLines} > 0` : Prisma.empty;
    const rows = await tx.$queryRaw<{ id: string; number: string; po_date: Date; expected: Date | null; supplier: string; status: string; total: number; units: bigint; value: bigint }[]>(Prisma.sql`
      SELECT po.id, po.number, po.po_date, po.expected_date AS expected, s.name AS supplier, po.status::text AS status, po.total_cents AS total, ${outstandingLines}::bigint AS units, ${outstandingValue}::bigint AS value
        FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id AND s.business_id = po.business_id WHERE ${base} ${outstandingOnly} ORDER BY po.po_date DESC, po.number DESC LIMIT ${limit} OFFSET ${offset}`);
    return {
      columns: [col('number', 'Order', 'text', { link: { path: '/purchase-orders', idKey: 'id' } }), col('poDate', 'Ordered', 'date'), col('expected', 'Expected', 'date'), col('supplier', 'Supplier', 'text'), col('status', 'Status', 'status'),
        col('total', 'Total (incl. VAT)', 'money', { needs: 'inventory.view_costs' }), col('units', 'Units outstanding', 'int'), col('outstandingValue', 'Outstanding value (ex VAT)', 'money', { needs: 'inventory.view_costs' })],
      rows: rows.map((r) => ({ id: r.id, number: r.number, poDate: isoDay(r.po_date), expected: isoDay(r.expected), supplier: r.supplier, status: PO_LABEL[r.status] ?? r.status, total: r.total, units: n(r.units), outstandingValue: n(r.value) })),
      total: group === 'outstanding' ? open.n : by.reduce((a, r) => a + r.n, 0), summary, notes,
    };
  },
};

export const PURCHASING: ReportDef[] = [suppliers, purchaseOrders];
