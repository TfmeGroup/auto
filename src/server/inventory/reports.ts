import { z } from 'zod';
import { Prisma, withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { addDays, dayRange, todayIso } from '@/lib/tz';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { margin, suggestedReorder } from './calc';
import { accessibleLocations, canSeeCosts, scopedLocationIds } from './common';
import { MOVEMENT_LABEL, type MovementType } from './stock';

/**
 * Inventory reporting from real transaction data. Every figure respects the caller's locations; costs, valuation and margins are shown only to
 * people allowed to see costs. The valuation is an OPERATIONAL figure (units on hand x the part's current cost per unit), not a formal accounting
 * stock valuation, and the screens say so; parts with no cost are counted and left out rather than guessed at.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
export const reportRangeSchema = z.object({ from: day.optional(), to: day.optional(), locationId: uuidSchema.optional(), by: z.enum(['part', 'job', 'customer', 'vehicle', 'invoice']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

function range(ctx: BusinessContext, q: { from?: string; to?: string }, defaultDays = 30) {
  const tz = ctx.business.timezone;
  const to = q.to ?? todayIso(tz);
  const from = q.from ?? addDays(to, -(defaultDays - 1));
  if (to < from) throw Errors.validation({ to: 'The end date cannot be before the start date.' });
  if ((dayRange(to, tz).end.getTime() - dayRange(from, tz).start.getTime()) / 86_400_000 > 731) throw Errors.validation({ from: 'Choose a period of at most two years.' });
  return { from, to, start: dayRange(from, tz).start, end: dayRange(to, tz).end };
}

const uuidList = (ids: string[]) => Prisma.sql`${ids}::uuid[]`;

// ───────── Dashboard ─────────

export async function getInventoryDashboard(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(z.object({ locationId: uuidSchema.optional() }), query);
  const costs = canSeeCosts(ctx);
  const bid = ctx.business.id;
  return withTenant(bid, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const all = await accessibleLocations(tx, ctx);
    const states = await tx.$queryRaw<{ id: string; on_hand: number; reserved: number; min_stock: number; reorder_level: number | null; cost_cents: number | null }[]>`
      SELECT p.id, p.min_stock, p.reorder_level, p.cost_cents,
             COALESCE(sum(sl.on_hand) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0)::int AS on_hand,
             COALESCE(sum(sl.reserved) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0)::int AS reserved
        FROM parts p LEFT JOIN stock_levels sl ON sl.part_id = p.id AND sl.business_id = p.business_id
       WHERE p.business_id = ${bid}::uuid AND p.status = 'ACTIVE' GROUP BY p.id`;
    let low = 0, out = 0, reservedUnits = 0, reservedParts = 0, onHandUnits = 0, value = 0, noCost = 0;
    const attention: { id: string; available: number; minStock: number; reorderLevel: number | null }[] = [];
    for (const s of states) {
      const available = s.on_hand - s.reserved;
      const threshold = Math.max(s.min_stock, s.reorder_level ?? 0);
      if (available <= 0) { out++; attention.push({ id: s.id, available, minStock: s.min_stock, reorderLevel: s.reorder_level }); }
      else if (threshold > 0 && available <= threshold) { low++; attention.push({ id: s.id, available, minStock: s.min_stock, reorderLevel: s.reorder_level }); }
      reservedUnits += s.reserved;
      if (s.reserved > 0) reservedParts++;
      onHandUnits += Math.max(0, s.on_hand);
      if (s.on_hand > 0) { if (s.cost_cents === null) noCost++; else value += s.on_hand * s.cost_cents; }
    }
    const recentLow = attention.sort((a, b) => a.available - b.available).slice(0, 6);
    const lowParts = await tx.part.findMany({ where: { businessId: bid, id: { in: recentLow.map((r) => r.id) } }, select: { id: true, sku: true, name: true, reorderQuantity: true } });
    const lp = new Map(lowParts.map((p) => [p.id, p]));

    const recentMovements = await tx.stockMovement.findMany({ where: { businessId: bid, locationId: { in: locs } }, orderBy: { createdAt: 'desc' }, take: 8, include: { part: { select: { sku: true, name: true } } } });
    const receipts = await tx.goodsReceipt.findMany({ where: { businessId: bid, locationId: { in: locs } }, orderBy: { receivedAt: 'desc' }, take: 5, select: { id: true, number: true, receivedAt: true, purchaseOrderId: true, supplierId: true } });
    const supplierNames = new Map((await tx.supplier.findMany({ where: { businessId: bid, id: { in: receipts.map((r) => r.supplierId) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const today = todayIso(ctx.business.timezone);
    const openOrders = await tx.purchaseOrder.findMany({ where: { businessId: bid, locationId: { in: locs }, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } }, orderBy: [{ expectedDate: 'asc' }], select: { id: true, number: true, status: true, expectedDate: true, totalCents: true, supplier: { select: { name: true } } } });
    const pending = await tx.purchaseOrder.count({ where: { businessId: bid, locationId: { in: locs }, status: { in: ['PENDING_APPROVAL'] } } });

    const since = new Date(Date.now() - 90 * 86_400_000);
    const used = await tx.$queryRaw<{ part_id: string; units: number; sku: string; name: string }[]>`
      SELECT m.part_id, sum(-m.on_hand_delta)::int AS units, p.sku, p.name FROM stock_movements m JOIN parts p ON p.id = m.part_id
       WHERE m.business_id = ${bid}::uuid AND m.type IN ('USED', 'SOLD') AND m.created_at >= ${since} AND m.location_id = ANY(${uuidList(locs)})
       GROUP BY m.part_id, p.sku, p.name ORDER BY units DESC LIMIT 5`;
    const oldest = await tx.stockMovement.findFirst({ where: { businessId: bid }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    const enoughHistory = !!oldest && oldest.createdAt <= since;
    const slow = enoughHistory
      ? await tx.$queryRaw<{ id: string; sku: string; name: string; on_hand: number; last_used: Date | null }[]>`
          SELECT p.id, p.sku, p.name, sum(sl.on_hand)::int AS on_hand,
                 (SELECT max(m.created_at) FROM stock_movements m WHERE m.part_id = p.id AND m.type IN ('USED', 'SOLD')) AS last_used
            FROM parts p JOIN stock_levels sl ON sl.part_id = p.id AND sl.location_id = ANY(${uuidList(locs)})
           WHERE p.business_id = ${bid}::uuid AND p.status = 'ACTIVE' AND p.created_at < ${since}
             AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.part_id = p.id AND m.type IN ('USED', 'SOLD') AND m.created_at >= ${since})
           GROUP BY p.id HAVING sum(sl.on_hand) > 0 ORDER BY sum(sl.on_hand) DESC LIMIT 5`
      : [];
    const parts = await tx.part.count({ where: { businessId: bid, status: 'ACTIVE' } });
    return {
      locationId: q.locationId ?? null, locations: all,
      kpis: { totalItems: parts, onHandUnits, lowStock: low, outOfStock: out, reservedUnits, reservedParts, openOrders: openOrders.length, pendingApproval: pending, lateOrders: openOrders.filter((o) => o.expectedDate && o.expectedDate.toISOString().slice(0, 10) < today).length },
      valuation: costs ? { valueCents: value, partsWithoutCost: noCost, note: 'Units on hand x each part\'s current cost. An operational figure, not an accounting stock valuation.' } : null,
      needsAttention: recentLow.map((r) => ({ ...r, sku: lp.get(r.id)?.sku ?? '', name: lp.get(r.id)?.name ?? '', suggestedOrder: suggestedReorder(r.available, r.minStock, r.reorderLevel, lp.get(r.id)?.reorderQuantity) })),
      recentMovements: recentMovements.map((m) => ({ id: m.id, at: m.createdAt, type: m.type as MovementType, label: MOVEMENT_LABEL[m.type as MovementType], sku: m.part.sku, partName: m.part.name, delta: m.onHandDelta !== 0 ? m.onHandDelta : m.reservedDelta, onHandAfter: m.onHandAfter })),
      recentPurchases: receipts.map((r) => ({ id: r.id, number: r.number, receivedAt: r.receivedAt, orderId: r.purchaseOrderId, supplierName: supplierNames.get(r.supplierId) ?? '' })),
      pendingDeliveries: openOrders.slice(0, 6).map((o) => ({ id: o.id, number: o.number, status: o.status, supplierName: o.supplier.name, expectedDate: o.expectedDate ? o.expectedDate.toISOString().slice(0, 10) : null, late: !!o.expectedDate && o.expectedDate.toISOString().slice(0, 10) < today, totalCents: costs ? o.totalCents : null })),
      frequentlyUsed: used.map((u) => ({ partId: u.part_id, sku: u.sku, name: u.name, units: u.units })),
      slowMoving: { enoughHistory, windowDays: 90, items: slow.map((s) => ({ id: s.id, sku: s.sku, name: s.name, onHand: s.on_hand, lastUsed: s.last_used })) },
      canSeeCosts: costs,
    };
  });
}

// ───────── Detailed reports ─────────

export async function lowStockReport(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(reportRangeSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const rows = await tx.$queryRaw<{ id: string; sku: string; name: string; min_stock: number; reorder_level: number | null; reorder_quantity: number | null; on_hand: number; reserved: number; supplier: string | null; cost_cents: number | null }[]>`
      SELECT p.id, p.sku, p.name, p.min_stock, p.reorder_level, p.reorder_quantity, p.cost_cents, s.name AS supplier,
             COALESCE(sum(sl.on_hand) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0)::int AS on_hand,
             COALESCE(sum(sl.reserved) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0)::int AS reserved
        FROM parts p LEFT JOIN stock_levels sl ON sl.part_id = p.id LEFT JOIN suppliers s ON s.id = p.primary_supplier_id
       WHERE p.business_id = ${ctx.business.id}::uuid AND p.status = 'ACTIVE' GROUP BY p.id, s.name
      HAVING COALESCE(sum(sl.on_hand) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0) - COALESCE(sum(sl.reserved) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0) <= GREATEST(p.min_stock, COALESCE(p.reorder_level, 0))
         AND (GREATEST(p.min_stock, COALESCE(p.reorder_level, 0)) > 0 OR COALESCE(sum(sl.on_hand) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0) - COALESCE(sum(sl.reserved) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0) <= 0)
       ORDER BY (COALESCE(sum(sl.on_hand) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0) - COALESCE(sum(sl.reserved) FILTER (WHERE sl.location_id = ANY(${uuidList(locs)})), 0)) ASC, lower(p.name) LIMIT ${q.limit ?? 200}`;
    const costs = canSeeCosts(ctx);
    return rows.map((r) => {
      const available = r.on_hand - r.reserved;
      const suggested = suggestedReorder(available, r.min_stock, r.reorder_level, r.reorder_quantity);
      return { id: r.id, sku: r.sku, name: r.name, onHand: r.on_hand, reserved: r.reserved, available, minStock: r.min_stock, reorderLevel: r.reorder_level, state: available <= 0 ? ('OUT' as const) : ('LOW' as const), supplier: r.supplier, suggestedOrder: suggested, estimatedCostCents: costs && r.cost_cents !== null ? suggested * r.cost_cents : null };
    });
  });
}

/** Valuation by category, supplier or location. */
export async function valuationReport(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view_costs');
  requireFeature(ctx.subscription, 'inventory_reports');
  const q = parseOrThrow(z.object({ locationId: uuidSchema.optional(), by: z.enum(['category', 'supplier', 'location']).default('category') }), query);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const key = { category: Prisma.sql`COALESCE(c.name, 'Uncategorised')`, supplier: Prisma.sql`COALESCE(s.name, 'No supplier')`, location: Prisma.sql`l.name` }[q.by];
    const rows = await tx.$queryRaw<{ label: string; parts: number; units: number; value: number; no_cost: number }[]>`
      SELECT ${key} AS label, count(DISTINCT p.id)::int AS parts, sum(sl.on_hand)::int AS units,
             COALESCE(sum(sl.on_hand * p.cost_cents) FILTER (WHERE p.cost_cents IS NOT NULL), 0)::bigint AS value,
             count(DISTINCT p.id) FILTER (WHERE p.cost_cents IS NULL)::int AS no_cost
        FROM stock_levels sl JOIN parts p ON p.id = sl.part_id JOIN locations l ON l.id = sl.location_id
        LEFT JOIN part_categories c ON c.id = p.category_id LEFT JOIN suppliers s ON s.id = p.primary_supplier_id
       WHERE sl.business_id = ${ctx.business.id}::uuid AND sl.on_hand > 0 AND sl.location_id = ANY(${uuidList(locs)})
       GROUP BY 1 ORDER BY value DESC, 1`;
    return {
      by: q.by, note: "Units on hand x each part's current cost. An operational figure, not an accounting stock valuation.",
      rows: rows.map((r) => ({ label: r.label, parts: r.parts, units: r.units, valueCents: Number(r.value), partsWithoutCost: r.no_cost })),
      totalCents: rows.reduce((s, r) => s + Number(r.value), 0),
    };
  });
}

export async function usageReport(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(reportRangeSchema, query);
  const r = range(ctx, q);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const rows = await tx.$queryRaw<{ part_id: string; sku: string; name: string; units: number; jobs: number; cost: number | null }[]>`
      SELECT m.part_id, p.sku, p.name, sum(-m.on_hand_delta)::int AS units, count(DISTINCT m.job_id)::int AS jobs,
             sum(-m.on_hand_delta * m.unit_cost_cents) FILTER (WHERE m.unit_cost_cents IS NOT NULL)::bigint AS cost
        FROM stock_movements m JOIN parts p ON p.id = m.part_id
       WHERE m.business_id = ${ctx.business.id}::uuid AND m.type IN ('USED', 'SOLD') AND m.created_at >= ${r.start} AND m.created_at < ${r.end} AND m.location_id = ANY(${uuidList(locs)})
       GROUP BY m.part_id, p.sku, p.name ORDER BY units DESC LIMIT ${q.limit ?? 200}`;
    return { range: { from: r.from, to: r.to }, items: rows.map((x) => ({ partId: x.part_id, sku: x.sku, name: x.name, units: x.units, jobs: x.jobs, costCents: costs && x.cost !== null ? Number(x.cost) : null })) };
  });
}

export async function movementSummary(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(reportRangeSchema, query);
  const r = range(ctx, q);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const rows = await tx.stockMovement.groupBy({ by: ['type'], where: { businessId: ctx.business.id, locationId: { in: locs }, createdAt: { gte: r.start, lt: r.end } }, _count: { _all: true }, _sum: { onHandDelta: true, reservedDelta: true } });
    return { range: { from: r.from, to: r.to }, items: rows.map((x) => ({ type: x.type as MovementType, label: MOVEMENT_LABEL[x.type as MovementType], movements: x._count._all, onHandChange: x._sum.onHandDelta ?? 0, reservedChange: x._sum.reservedDelta ?? 0 })) };
  });
}

/**
 * Part margins from finalised invoices: revenue (excluding VAT) less the cost recorded on each line, grouped by part, job, customer, vehicle
 * or invoice. Lines with no recorded cost are counted as zero cost and the report says how many there were. Credit notes are not netted off.
 */
export async function marginReport(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view_costs');
  requireFeature(ctx.subscription, 'inventory_reports');
  const q = parseOrThrow(reportRangeSchema, query);
  const r = range(ctx, q, 90);
  const by = q.by ?? 'part';
  return withTenant(ctx.business.id, async (tx) => {
    const scopeIds = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const key = {
      part: Prisma.sql`COALESCE(il.inventory_item_id, jp.inventory_item_id)::text`, job: Prisma.sql`i.job_id::text`, customer: Prisma.sql`i.customer_id::text`, vehicle: Prisma.sql`i.vehicle_id::text`, invoice: Prisma.sql`i.id::text`,
    }[by];
    const rows = await tx.$queryRaw<{ k: string | null; revenue: number; cost: number; lines: number; no_cost: number }[]>`
      SELECT ${key} AS k, sum(il.taxable_cents)::bigint AS revenue,
             COALESCE(sum(round(il.unit_cost_cents::numeric * il.quantity_milli / 1000)) FILTER (WHERE il.unit_cost_cents IS NOT NULL), 0)::bigint AS cost,
             count(*)::int AS lines, count(*) FILTER (WHERE il.unit_cost_cents IS NULL)::int AS no_cost
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id AND i.business_id = il.business_id
        LEFT JOIN job_parts jp ON jp.id = il.job_part_id AND jp.business_id = il.business_id
       WHERE il.business_id = ${ctx.business.id}::uuid AND il.line_type = 'PART' AND i.finalised_at IS NOT NULL AND i.status <> 'CANCELLED'
         AND i.invoice_date >= ${r.from}::date AND i.invoice_date <= ${r.to}::date AND (i.location_id IS NULL OR i.location_id = ANY(${uuidList(scopeIds)}))
         ${by === 'part' ? Prisma.sql`AND COALESCE(il.inventory_item_id, jp.inventory_item_id) IS NOT NULL` : Prisma.empty}
       GROUP BY 1 ORDER BY revenue DESC LIMIT ${q.limit ?? 200}`;
    const ids = rows.map((x) => x.k).filter((v): v is string => !!v);
    const labels = new Map<string, string>();
    if (ids.length) {
      if (by === 'part') for (const p of await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: ids } }, select: { id: true, sku: true, name: true } })) labels.set(p.id, `${p.sku} — ${p.name}`);
      if (by === 'job') for (const j of await tx.jobCard.findMany({ where: { businessId: ctx.business.id, id: { in: ids } }, select: { id: true, jobNumber: true } })) labels.set(j.id, j.jobNumber);
      if (by === 'customer') for (const c of await tx.customer.findMany({ where: { businessId: ctx.business.id, id: { in: ids } }, select: { id: true, name: true } })) labels.set(c.id, c.name);
      if (by === 'vehicle') for (const v of await tx.vehicle.findMany({ where: { businessId: ctx.business.id, id: { in: ids } }, select: { id: true, registration: true, make: true, model: true } })) labels.set(v.id, v.registration ?? `${v.make ?? ''} ${v.model ?? ''}`.trim());
      if (by === 'invoice') for (const i of await tx.invoice.findMany({ where: { businessId: ctx.business.id, id: { in: ids } }, select: { id: true, number: true } })) labels.set(i.id, i.number ?? 'Draft');
    }
    const items = rows.map((x) => {
      const m = margin(Number(x.revenue), Number(x.cost));
      return { key: x.k, label: x.k ? (labels.get(x.k) ?? '—') : 'Not linked', revenueCents: Number(x.revenue), costCents: Number(x.cost), marginCents: m.marginCents, marginBps: m.marginBps, lines: x.lines, linesWithoutCost: x.no_cost };
    });
    return { range: { from: r.from, to: r.to }, by, items, totals: (() => { const rev = items.reduce((s, i) => s + i.revenueCents, 0); const cost = items.reduce((s, i) => s + i.costCents, 0); return { revenueCents: rev, costCents: cost, ...margin(rev, cost), linesWithoutCost: items.reduce((s, i) => s + i.linesWithoutCost, 0) }; })() };
  });
}

export async function purchaseSummary(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view_costs');
  requireFeature(ctx.subscription, 'inventory_reports');
  const q = parseOrThrow(reportRangeSchema, query);
  const r = range(ctx, q, 90);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const rows = await tx.$queryRaw<{ supplier_id: string; name: string; orders: number; ordered: number; received: number }[]>`
      SELECT po.supplier_id, s.name, count(DISTINCT po.id)::int AS orders,
             COALESCE(sum(po.total_cents) FILTER (WHERE po.status IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED')), 0)::bigint AS ordered,
             COALESCE((SELECT sum(rl.quantity_received * rl.unit_cost_cents + rl.vat_cents) FROM goods_receipt_lines rl JOIN goods_receipts gr ON gr.id = rl.receipt_id
                        WHERE gr.business_id = po.business_id AND gr.supplier_id = po.supplier_id AND gr.location_id = ANY(${uuidList(locs)}) AND gr.received_at >= ${r.start} AND gr.received_at < ${r.end}), 0)::bigint AS received
        FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.business_id = ${ctx.business.id}::uuid AND po.location_id = ANY(${uuidList(locs)}) AND po.po_date >= ${r.from}::date AND po.po_date <= ${r.to}::date AND po.status <> 'DRAFT'
       GROUP BY po.supplier_id, s.name, po.business_id ORDER BY ordered DESC`;
    return { range: { from: r.from, to: r.to }, items: rows.map((x) => ({ supplierId: x.supplier_id, name: x.name, orders: x.orders, orderedCents: Number(x.ordered), receivedCents: Number(x.received) })) };
  });
}


/** A few counts for the main dashboard: cheap, limited to the caller's locations, and null for people who cannot see stock. */
export async function getInventorySnapshot(ctx: BusinessContext): Promise<{ lowStock: number; outOfStock: number; openOrders: number | null; lateOrders: number | null } | null> {
  if (!ctx.permissions.has('inventory.view')) return null;
  const bid = ctx.business.id;
  return withTenant(bid, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx);
    const rows = await tx.$queryRaw<{ low: number; out: number }[]>`
      SELECT count(*) FILTER (WHERE avail > 0 AND thr > 0 AND avail <= thr)::int AS low, count(*) FILTER (WHERE avail <= 0)::int AS out FROM (
        SELECT p.id, GREATEST(p.min_stock, COALESCE(p.reorder_level, 0)) AS thr,
               COALESCE((SELECT sum(sl.on_hand - sl.reserved) FROM stock_levels sl WHERE sl.part_id = p.id AND sl.business_id = ${bid}::uuid AND sl.location_id = ANY(${uuidList(locs)})), 0) AS avail
          FROM parts p WHERE p.business_id = ${bid}::uuid AND p.status = 'ACTIVE') t`;
    const hasPO = ctx.subscription.features.has('purchase_orders');
    const today = todayIso(ctx.business.timezone);
    const open = hasPO ? await tx.purchaseOrder.findMany({ where: { businessId: bid, locationId: { in: locs }, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } }, select: { expectedDate: true } }) : null;
    return { lowStock: rows[0]?.low ?? 0, outOfStock: rows[0]?.out ?? 0, openOrders: open ? open.length : null, lateOrders: open ? open.filter((o) => o.expectedDate && o.expectedDate.toISOString().slice(0, 10) < today).length : null };
  });
}
