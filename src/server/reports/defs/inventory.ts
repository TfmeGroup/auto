import { Prisma } from '@/server/db/client';
import { MOVEMENT_LABEL, type MovementType } from '@/server/inventory/stock';
import { bar, col, fillPeriods, isoDay, localDate, n, pageOf, periodLabel, UNIT_GROUPS, unitSql, type Unit } from './util';
import type { ReportDef, RunEnv } from '../types';

/**
 * Inventory reports read the stock ledger (stock_movements) and the live stock levels. Every figure is limited to the locations the
 * caller may use; costs and values are removed for people without inventory.view_costs. Stock value is units on hand x the part's
 * current cost per unit: an operational figure, not an accounting valuation.
 */

const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

// ───────────────────────── stock position ─────────────────────────

export const stock: ReportDef = {
  key: 'stock', title: 'Stock on hand', category: 'inventory', dated: false, paged: true,
  description: 'On hand, reserved and available for every part, with low and out-of-stock flags and stock value.',
  permissions: ['inventory.view'], filters: ['location', 'category', 'supplier', 'stockStatus', 'search'],
  async run(env) {
    const { tx, ctx, params } = env;
    const bid = ctx.business.id;
    const search = params.search ? Prisma.sql`AND (p.name ILIKE ${like(params.search)} OR p.sku ILIKE ${like(params.search)} OR p.part_number ILIKE ${like(params.search)} OR p.barcode ILIKE ${like(params.search)})` : Prisma.empty;
    const inner = Prisma.sql`
      SELECT p.id, p.sku, p.name, cat.name AS category, s.name AS supplier, p.min_stock, p.reorder_level, p.cost_cents,
             COALESCE(SUM(sl.on_hand),0)::int AS on_hand, COALESCE(SUM(sl.reserved),0)::int AS reserved
        FROM parts p LEFT JOIN part_categories cat ON cat.id = p.category_id AND cat.business_id = p.business_id LEFT JOIN suppliers s ON s.id = p.primary_supplier_id AND s.business_id = p.business_id
        LEFT JOIN stock_levels sl ON sl.part_id = p.id AND sl.business_id = p.business_id ${env.loc('sl', { includeNull: false })}
       WHERE p.business_id = ${bid}::uuid AND p.status = 'ACTIVE' ${env.eq('p.category_id', params.categoryId, 'uuid')} ${env.eq('p.primary_supplier_id', params.supplierId, 'uuid')} ${search}
       GROUP BY p.id, cat.name, s.name`;
    const withStatus = Prisma.sql`SELECT q.*, (q.on_hand - q.reserved) AS available,
        CASE WHEN q.on_hand - q.reserved <= 0 THEN 'OUT' WHEN GREATEST(q.min_stock, COALESCE(q.reorder_level,0)) > 0 AND q.on_hand - q.reserved <= GREATEST(q.min_stock, COALESCE(q.reorder_level,0)) THEN 'LOW' ELSE 'OK' END AS stock_status FROM (${inner}) q`;
    const filter = params.stockStatus ? Prisma.sql`WHERE w.stock_status = ${params.stockStatus}` : Prisma.empty;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; sku: string; name: string; category: string | null; supplier: string | null; on_hand: number; reserved: number; available: number; min_stock: number; reorder_level: number | null; cost_cents: number | null; stock_status: string }[]>(Prisma.sql`
      SELECT * FROM (${withStatus}) w ${filter} ORDER BY w.name ASC LIMIT ${limit} OFFSET ${offset}`);
    const t = (await tx.$queryRaw<{ parts: number; on_hand: bigint; reserved: bigint; low: number; out: number; value: bigint; no_cost: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS parts, COALESCE(SUM(GREATEST(w.on_hand,0)),0)::bigint AS on_hand, COALESCE(SUM(w.reserved),0)::bigint AS reserved,
             COUNT(*) FILTER (WHERE w.stock_status = 'LOW')::int AS low, COUNT(*) FILTER (WHERE w.stock_status = 'OUT')::int AS out,
             COALESCE(SUM(CASE WHEN w.on_hand > 0 AND w.cost_cents IS NOT NULL THEN w.on_hand::bigint * w.cost_cents ELSE 0 END),0)::bigint AS value,
             COUNT(*) FILTER (WHERE w.on_hand > 0 AND w.cost_cents IS NULL)::int AS no_cost
        FROM (${withStatus}) w ${filter}`))[0]!;
    const STATUS: Record<string, string> = { OK: 'In stock', LOW: 'Low stock', OUT: 'Out of stock' };
    return {
      columns: [
        col('sku', 'SKU', 'text', { link: { path: '/inventory/parts', idKey: 'id' } }), col('name', 'Part', 'text'), col('category', 'Category', 'text'), col('supplier', 'Supplier', 'text'),
        col('onHand', 'On hand', 'int'), col('reserved', 'Reserved', 'int'), col('available', 'Available', 'int'), col('status', 'Status', 'status'),
        col('reorderAt', 'Reorder at', 'int'), col('cost', 'Unit cost', 'money', { needs: 'inventory.view_costs' }), col('value', 'Stock value', 'money', { needs: 'inventory.view_costs' }),
      ],
      rows: rows.map((r) => ({
        id: r.id, sku: r.sku, name: r.name, category: r.category, supplier: r.supplier, onHand: r.on_hand, reserved: r.reserved, available: r.available, status: STATUS[r.stock_status] ?? r.stock_status,
        reorderAt: Math.max(r.min_stock, r.reorder_level ?? 0) || null, cost: r.cost_cents, value: r.cost_cents !== null && r.on_hand > 0 ? r.on_hand * r.cost_cents : null,
      })),
      total: t.parts,
      summary: [
        { key: 'parts', label: 'Parts', value: t.parts, type: 'int' },
        { key: 'onHand', label: 'Units on hand', value: n(t.on_hand), type: 'int' },
        { key: 'reserved', label: 'Reserved for jobs', value: n(t.reserved), type: 'int' },
        { key: 'available', label: 'Available', value: n(t.on_hand) - n(t.reserved), type: 'int' },
        { key: 'low', label: 'Low stock', value: t.low, type: 'int', tone: t.low > 0 ? 'warn' : undefined },
        { key: 'out', label: 'Out of stock', value: t.out, type: 'int', tone: t.out > 0 ? 'danger' : undefined },
        { key: 'value', label: 'Stock value (at cost)', value: n(t.value), type: 'money', needs: 'inventory.view_costs', hint: t.no_cost ? `${t.no_cost} part${t.no_cost === 1 ? '' : 's'} in stock have no cost recorded and are left out` : undefined },
      ],
      charts: [bar('Parts by stock level', 'int', ['In stock', 'Low stock', 'Out of stock'], [{ name: 'Parts', values: [t.parts - t.low - t.out, t.low, t.out] }])],
      notes: ['Available is on hand minus reserved. Low means available is at or below the larger of the part\'s minimum and reorder level.', 'Counts cover the locations you may use (or the one you chose).'],
    };
  },
};

// ───────────────────────── movements ─────────────────────────

export const stockMovements: ReportDef = {
  key: 'stock_movements', title: 'Stock movements', category: 'inventory', dated: true, paged: true, feature: 'inventory_reports',
  description: 'Every change to stock in the period: used, received, returned, damaged, lost, adjusted, transferred.',
  permissions: ['inventory.view'], filters: ['range', 'location', 'part', 'category', 'supplier', 'movementType'],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const day = localDate('m.created_at', tz);
    const where = Prisma.sql`m.business_id = ${bid}::uuid AND ${day} BETWEEN ${range.from}::date AND ${range.to}::date ${env.loc('m', { includeNull: false })}
      ${env.eq('m.part_id', params.partId, 'uuid')} ${env.eq('p.category_id', params.categoryId, 'uuid')} ${env.eq('p.primary_supplier_id', params.supplierId, 'uuid')}
      ${params.movementType ? Prisma.sql`AND m.type = ${params.movementType}::stock_movement_type` : Prisma.empty}`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; at: Date; part_id: string; sku: string; name: string; type: string; delta: number; reserved: number; location: string; reason: string | null; cost: number | null; user: string | null }[]>(Prisma.sql`
      SELECT m.id, m.created_at AS at, p.id AS part_id, p.sku, p.name, m.type::text AS type, m.on_hand_delta AS delta, m.reserved_delta AS reserved, l.name AS location, m.reason, m.unit_cost_cents AS cost, u.name AS "user"
        FROM stock_movements m JOIN parts p ON p.id = m.part_id AND p.business_id = m.business_id LEFT JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.created_by_id
       WHERE ${where} ORDER BY m.created_at DESC LIMIT ${limit} OFFSET ${offset}`);
    const by = await tx.$queryRaw<{ type: string; n: number; units: bigint }[]>(Prisma.sql`
      SELECT m.type::text AS type, COUNT(*)::int AS n, COALESCE(SUM(CASE WHEN m.type IN ('RESERVED','UNRESERVED') THEN ABS(m.reserved_delta) ELSE ABS(m.on_hand_delta) END),0)::bigint AS units
        FROM stock_movements m JOIN parts p ON p.id = m.part_id AND p.business_id = m.business_id WHERE ${where} GROUP BY m.type`);
    const g = (...types: string[]) => by.filter((r) => types.includes(r.type)).reduce((a, r) => a + n(r.units), 0);
    const total = by.reduce((a, r) => a + r.n, 0);
    const TYPES = Object.keys(MOVEMENT_LABEL) as MovementType[];
    return {
      columns: [
        col('at', 'When', 'datetime'), col('sku', 'SKU', 'text', { link: { path: '/inventory/parts', idKey: 'partId' } }), col('name', 'Part', 'text'), col('type', 'Movement', 'text'), col('change', 'Change in stock', 'int'),
        col('reservedChange', 'Change in reserved', 'int'), col('location', 'Location', 'text'), col('reason', 'Reason', 'text'), col('unitCost', 'Unit cost', 'money', { needs: 'inventory.view_costs' }), col('user', 'By', 'text'),
      ],
      rows: rows.map((r) => ({ id: r.id, at: r.at.toISOString(), partId: r.part_id, sku: r.sku, name: r.name, type: MOVEMENT_LABEL[r.type as MovementType] ?? r.type, change: r.delta, reservedChange: r.reserved, location: r.location, reason: r.reason, unitCost: r.cost, user: r.user })),
      total,
      summary: [
        { key: 'used', label: 'Parts used', value: g('USED'), type: 'int', hint: 'Units fitted to jobs' },
        { key: 'received', label: 'Parts received', value: g('RECEIVED'), type: 'int' },
        { key: 'returned', label: 'Parts returned', value: g('RETURNED'), type: 'int', hint: 'Back from jobs' },
        { key: 'supplierReturns', label: 'Returned to suppliers', value: g('SUPPLIER_RETURN'), type: 'int' },
        { key: 'damaged', label: 'Damaged', value: g('DAMAGED'), type: 'int' },
        { key: 'lost', label: 'Lost', value: g('LOST'), type: 'int' },
        { key: 'adjusted', label: 'Adjustments', value: g('ADJUSTED'), type: 'int' },
        { key: 'transfers', label: 'Transferred', value: g('TRANSFER_IN'), type: 'int', hint: 'Units arriving at a location' },
      ],
      charts: [bar('Units by movement type', 'int', TYPES.map((t) => MOVEMENT_LABEL[t]), [{ name: 'Units', values: TYPES.map((t) => g(t)) }])],
      notes: ['Movements are an append-only ledger: nothing here is edited after the fact. Reserve and release show the reserved change; all others show the stock change.'],
    };
  },
};

// ───────────────────────── usage ─────────────────────────

export const partsUsage: ReportDef = {
  key: 'parts_usage', title: 'Parts usage', category: 'inventory', dated: true, paged: true, feature: 'inventory_reports',
  description: 'Which parts are used, by part, job type, technician, vehicle or period. Counts parts fitted to jobs and sold, less parts returned.',
  permissions: ['inventory.view'], filters: ['range', 'location', 'category', 'supplier', 'part', 'technician', 'vehicle', 'serviceType'],
  groupBys: [{ key: 'part', label: 'By part' }, { key: 'service', label: 'By job type' }, { key: 'technician', label: 'By technician' }, { key: 'vehicle', label: 'By vehicle' }, ...UNIT_GROUPS],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const group = params.groupBy ?? 'part';
    const unit: Unit | null = group === 'day' || group === 'week' || group === 'month' ? group : null;
    const key = group === 'service' ? Prisma.sql`COALESCE(j.service_label, '(no job)')` : group === 'technician' ? Prisma.sql`COALESCE(u.name, 'Unassigned')`
      : group === 'vehicle' ? Prisma.sql`COALESCE(v.registration, '(no vehicle)')` : unit ? Prisma.sql`date_trunc(${unitSql(unit)}, ${localDate('m.created_at', tz)})::date::text` : Prisma.sql`p.sku || ' — ' || p.name`;
    const where = Prisma.sql`
      m.business_id = ${bid}::uuid AND m.type IN ('USED','SOLD','RETURNED') AND ${localDate('m.created_at', tz)} BETWEEN ${range.from}::date AND ${range.to}::date ${env.loc('m', { includeNull: false })}
      ${env.eq('m.part_id', params.partId, 'uuid')} ${env.eq('p.category_id', params.categoryId, 'uuid')} ${env.eq('p.primary_supplier_id', params.supplierId, 'uuid')} ${env.eq('j.vehicle_id', params.vehicleId, 'uuid')} ${env.eq('j.service_type_id', params.serviceTypeId, 'uuid')}
      ${params.technicianId ? Prisma.sql`AND j.primary_technician_membership_id = ${params.technicianId}::uuid` : Prisma.empty}`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ k: string; units: bigint; jobs: number; cost: bigint }[]>(Prisma.sql`
      SELECT ${key} AS k, COALESCE(SUM(-m.on_hand_delta),0)::bigint AS units, COUNT(DISTINCT m.job_id)::int AS jobs,
             COALESCE(SUM(-m.on_hand_delta * m.unit_cost_cents) FILTER (WHERE m.unit_cost_cents IS NOT NULL),0)::bigint AS cost
        FROM stock_movements m JOIN parts p ON p.id = m.part_id AND p.business_id = m.business_id LEFT JOIN job_cards j ON j.id = m.job_id AND j.business_id = m.business_id
        LEFT JOIN memberships mm ON mm.id = j.primary_technician_membership_id LEFT JOIN users u ON u.id = mm.user_id LEFT JOIN vehicles v ON v.id = j.vehicle_id AND v.business_id = j.business_id
       WHERE ${where} GROUP BY 1 ${unit ? Prisma.sql`ORDER BY 1` : Prisma.sql`ORDER BY units DESC, 1`} ${unit ? Prisma.empty : Prisma.sql`LIMIT ${limit} OFFSET ${offset}`}`);
    const totals = (await tx.$queryRaw<{ units: bigint; jobs: number; groups: number }[]>(Prisma.sql`
      SELECT COALESCE(SUM(-m.on_hand_delta),0)::bigint AS units, COUNT(DISTINCT m.job_id)::int AS jobs, COUNT(DISTINCT ${key})::int AS groups
        FROM stock_movements m JOIN parts p ON p.id = m.part_id AND p.business_id = m.business_id LEFT JOIN job_cards j ON j.id = m.job_id AND j.business_id = m.business_id
        LEFT JOIN memberships mm ON mm.id = j.primary_technician_membership_id LEFT JOIN users u ON u.id = mm.user_id LEFT JOIN vehicles v ON v.id = j.vehicle_id AND v.business_id = j.business_id WHERE ${where}`))[0]!;
    type R = { period: string; label: string; units: number; jobs: number; cost: number };
    let data: R[] = rows.map((r) => ({ period: r.k, label: r.k, units: n(r.units), jobs: r.jobs, cost: n(r.cost) }));
    if (unit) data = fillPeriods(env, unit, data, (p) => ({ period: p, label: p, units: 0, jobs: 0, cost: 0 })).map((r) => ({ ...r, label: periodLabel(r.period, unit) }));
    return {
      columns: [col('group', { part: 'Part', service: 'Job type', technician: 'Technician', vehicle: 'Vehicle' }[group] ?? (unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month'), 'text'), col('units', 'Units used', 'int'), col('jobs', 'Jobs', 'int'), col('cost', 'Cost of parts used', 'money', { needs: 'inventory.view_costs' })],
      rows: data.map((r) => ({ group: r.label, units: r.units, jobs: r.jobs, cost: r.cost })),
      total: unit ? data.length : totals.groups,
      summary: [{ key: 'units', label: 'Units used', value: n(totals.units), type: 'int' }, { key: 'jobs', label: 'Jobs using parts', value: totals.jobs, type: 'int' }],
      charts: [bar(unit ? 'Parts used over time' : 'Most-used parts', 'int', data.slice(0, 15).map((r) => r.label), [{ name: 'Units', values: data.slice(0, 15).map((r) => r.units) }], unit ? 'line' : 'bar')],
      notes: ['Usage is units fitted to jobs or sold, less units returned from jobs, from the stock ledger. By technician and vehicle follow the job the stock was used on.'],
    };
  },
};

// ───────────────────────── slow moving ─────────────────────────

export const slowMoving: ReportDef = {
  key: 'slow_moving', title: 'Slow-moving stock', category: 'inventory', dated: false, paged: true, feature: 'inventory_reports',
  description: 'Parts in stock that have not been used or sold for the period set in Reporting settings (90 days by default).',
  permissions: ['inventory.view'], filters: ['location', 'category', 'supplier', 'search'],
  async run(env) {
    const { tx, ctx, params, config } = env;
    const bid = ctx.business.id;
    const days = config.slowMovingDays;
    const first = await tx.stockMovement.findFirst({ where: { businessId: bid }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    const history = first ? Math.floor((Date.now() - first.createdAt.getTime()) / 86_400_000) : 0;
    const costs = env.can('inventory.view_costs');
    const cols = [
      col('sku', 'SKU', 'text', { link: { path: '/inventory/parts', idKey: 'id' } }), col('name', 'Part', 'text'), col('category', 'Category', 'text'), col('onHand', 'On hand', 'int'),
      col('lastUsed', 'Last used', 'date'), col('daysSince', 'Days since used', 'int'), col('value', 'Stock value', 'money', { needs: 'inventory.view_costs' }),
    ];
    // Not enough history means nothing can honestly be called slow: say so instead of listing every part.
    if (history < days) {
      return { columns: cols, rows: [], total: 0, summary: [{ key: 'days', label: 'Slow-moving threshold (days)', value: days, type: 'int' }, { key: 'history', label: 'Days of stock history', value: history, type: 'int' }],
        notes: [`There are ${history} days of stock history and the threshold is ${days} days, so no part can fairly be called slow-moving yet.`] };
    }
    const search = params.search ? Prisma.sql`AND (p.name ILIKE ${like(params.search)} OR p.sku ILIKE ${like(params.search)})` : Prisma.empty;
    const inner = Prisma.sql`
      SELECT p.id, p.sku, p.name, cat.name AS category, p.cost_cents, COALESCE(SUM(sl.on_hand),0)::int AS on_hand,
             (SELECT MAX(m.created_at) FROM stock_movements m WHERE m.part_id = p.id AND m.business_id = p.business_id AND m.type IN ('USED','SOLD')) AS last_used
        FROM parts p LEFT JOIN part_categories cat ON cat.id = p.category_id AND cat.business_id = p.business_id
        JOIN stock_levels sl ON sl.part_id = p.id AND sl.business_id = p.business_id ${env.loc('sl', { includeNull: false })}
       WHERE p.business_id = ${bid}::uuid AND p.status = 'ACTIVE' AND p.created_at < now() - make_interval(days => ${days}) ${env.eq('p.category_id', params.categoryId, 'uuid')} ${env.eq('p.primary_supplier_id', params.supplierId, 'uuid')} ${search}
       GROUP BY p.id, cat.name HAVING COALESCE(SUM(sl.on_hand),0) > 0`;
    const slow = Prisma.sql`SELECT q.* FROM (${inner}) q WHERE q.last_used IS NULL OR q.last_used < now() - make_interval(days => ${days})`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; sku: string; name: string; category: string | null; on_hand: number; cost_cents: number | null; last_used: Date | null; since: number | null }[]>(Prisma.sql`
      SELECT s.*, (CURRENT_DATE - s.last_used::date) AS since FROM (${slow}) s ORDER BY s.last_used ASC NULLS FIRST, s.name LIMIT ${limit} OFFSET ${offset}`);
    const t = (await tx.$queryRaw<{ n: number; units: bigint; value: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(s.on_hand),0)::bigint AS units, COALESCE(SUM(CASE WHEN s.cost_cents IS NOT NULL THEN s.on_hand::bigint * s.cost_cents ELSE 0 END),0)::bigint AS value FROM (${slow}) s`))[0]!;
    void costs;
    return {
      columns: cols,
      rows: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, category: r.category, onHand: r.on_hand, lastUsed: isoDay(r.last_used), daysSince: r.since, value: r.cost_cents !== null ? r.on_hand * r.cost_cents : null })),
      total: t.n,
      summary: [{ key: 'parts', label: 'Slow-moving parts', value: t.n, type: 'int', tone: t.n > 0 ? 'warn' : undefined }, { key: 'units', label: 'Units tied up', value: n(t.units), type: 'int' }, { key: 'value', label: 'Value tied up (at cost)', value: n(t.value), type: 'money', needs: 'inventory.view_costs' }, { key: 'days', label: 'Threshold (days)', value: days, type: 'int' }],
      charts: [],
      notes: [`A part is slow-moving when it is in stock, was added more than ${days} days ago, and has not been used or sold in the last ${days} days. Change the threshold in Settings, Reporting. Parts that have never been used show a blank last-used date.`],
    };
  },
};

export const INVENTORY: ReportDef[] = [stock, stockMovements, partsUsage, slowMoving];
void ({} as RunEnv);
