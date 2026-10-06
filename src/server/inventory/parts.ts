import { z } from 'zod';
import { Prisma, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { escapeLike, optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import { nextNumber } from '@/server/numbering/sequence';
import { vehicleLabel } from '@/server/vehicles/service';
import type { BusinessContext } from '@/server/context';
import { availableOf, stockState, suggestedReorder, type StockState, type VehicleFacts } from './calc';
import { accessibleLocations, actorOf, canSeeCosts, loadInventorySettings, lockPartIdentifiers, resolveLocation, scopedLocationIds, trimOrNull, type InventorySettingsRow } from './common';
import { applyMovement, stockForParts, totalsFor, userNames } from './stock';

// ───────── Input ─────────

/** undefined = leave alone, null or "" = clear. (A form can send back what it read, and can clear a field.) */
const clearable = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
const clearableId = z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v === undefined ? undefined : v === '' || v === null ? null : v));
const cents = z.union([z.literal(''), z.null(), z.coerce.number().int('Enter whole cents').min(0, 'Cannot be negative').max(1_000_000_000)]).optional().transform((v) => (v === undefined ? undefined : v === '' || v === null ? null : v));
const qty = z.coerce.number().int('Enter a whole number').min(0, 'Cannot be negative').max(10_000_000);
const optionalQty = z.union([z.literal(''), z.null(), qty]).optional().transform((v) => (v === undefined ? undefined : v === '' || v === null ? null : v));

const partFields = {
  sku: z.string().trim().max(60),
  partNumber: clearable(80),
  name: z.string().trim().min(1, 'Enter a name').max(200),
  description: clearable(1000),
  categoryId: clearableId,
  brand: clearable(80),
  manufacturer: clearable(80),
  barcode: clearable(60),
  unit: z.string().trim().min(1).max(20),
  costCents: cents,
  sellPriceCents: cents,
  taxTreatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']),
  minStock: qty,
  reorderLevel: optionalQty,
  reorderQuantity: optionalQty,
  primarySupplierId: clearableId,
  notes: clearable(2000),
};

export const partCreateSchema = z.object({
  ...partFields,
  sku: partFields.sku.default(''),
  unit: partFields.unit.default('each'),
  taxTreatment: partFields.taxTreatment.default('STANDARD'),
  minStock: partFields.minStock.default(0),
  /** Stock on the shelf when the part is first added (recorded as an opening-balance adjustment; needs inventory.adjust). */
  openingQuantity: optionalQty,
  openingLocationId: clearableId,
  bin: clearable(40),
  storageArea: clearable(60),
});
export const partUpdateSchema = z.object(partFields).partial().extend({ reason: optionalText(200) });
export type PartCreate = z.output<typeof partCreateSchema>;

// ───────── Identifiers ─────────

/** SKU, part number and barcode uniqueness, as the business has configured it. Holds the business's identifier lock so two requests cannot both claim one. */
export async function assertIdentifiersFree(tx: Tx, businessId: string, settings: InventorySettingsRow, ids: { sku?: string | null; partNumber?: string | null; barcode?: string | null }, exceptId?: string): Promise<void> {
  await lockPartIdentifiers(tx, businessId);
  const other = exceptId ? { id: { not: exceptId } } : {};
  const clash = async (field: 'sku' | 'partNumber' | 'barcode', value: string, label: string) => {
    const hit = await tx.part.findFirst({ where: { businessId, ...other, [field]: { equals: value, mode: 'insensitive' } }, select: { sku: true, name: true, status: true } });
    if (hit) throw Errors.validation({ [field]: `${label} "${value}" is already used by ${hit.sku} (${hit.name})${hit.status === 'ARCHIVED' ? ', which is archived. Restore that part instead.' : '.'}` });
  };
  if (settings.uniqueSku && ids.sku) await clash('sku', ids.sku, 'The SKU');
  if (settings.uniquePartNumber && ids.partNumber) await clash('partNumber', ids.partNumber, 'The part number');
  if (settings.uniqueBarcode && ids.barcode) await clash('barcode', ids.barcode, 'The barcode');
}

async function assertRefs(tx: Tx, businessId: string, d: { categoryId?: string | null; primarySupplierId?: string | null }) {
  if (d.categoryId && !(await tx.partCategory.findFirst({ where: { id: d.categoryId, businessId, status: 'ACTIVE' }, select: { id: true } }))) throw Errors.validation({ categoryId: 'Choose a category of this business.' });
  if (d.primarySupplierId && !(await tx.supplier.findFirst({ where: { id: d.primarySupplierId, businessId, status: 'ACTIVE' }, select: { id: true } }))) throw Errors.validation({ primarySupplierId: 'Choose an active supplier of this business.' });
}

export async function recordPriceChange(
  tx: Tx, businessId: string, userId: string | null, partId: string,
  c: { previousCost: number | null; newCost: number | null; previousSell: number | null; newSell: number | null; source: string; reason?: string | null },
): Promise<boolean> {
  if (c.previousCost === c.newCost && c.previousSell === c.newSell) return false;
  await tx.partPriceHistory.create({
    data: { businessId, partId, previousCostCents: c.previousCost, newCostCents: c.newCost, previousSellCents: c.previousSell, newSellCents: c.newSell, source: c.source, reason: c.reason ?? null, changedById: userId },
  });
  return true;
}

// ───────── Create / update ─────────

/** Create a part inside an open transaction (used by the form and by import). Caller has checked permissions. */
import { loadConfig } from '@/server/settings/config';
import { priceWithMarkup } from '@/server/settings/config-service';

export async function createPartTx(tx: Tx, ctx: BusinessContext, d: PartCreate, source = 'CREATED') {
  const settings = await loadInventorySettings(tx, ctx.business.id);
  // The business's defaults fill what was left blank (reorder quantity; sell price from cost plus the default markup). What was typed always wins.
  const defaults = await loadConfig(tx, ctx.business.id);
  const reorderQuantity = d.reorderQuantity ?? defaults.defaultReorderQuantity ?? null;
  const sellPrice = d.sellPriceCents ?? (d.costCents !== undefined && d.costCents !== null && defaults.defaultMarkupBps !== null ? priceWithMarkup(d.costCents, defaults.defaultMarkupBps) : null);
  const sku = d.sku || (await nextNumber(tx, ctx.business.id, 'part', 'P', 6));
  const ids = { sku, partNumber: trimOrNull(d.partNumber), barcode: trimOrNull(d.barcode) };
  await assertIdentifiersFree(tx, ctx.business.id, settings, ids);
  await assertRefs(tx, ctx.business.id, d);
  const part = await tx.part.create({
    data: {
      businessId: ctx.business.id, sku, partNumber: ids.partNumber, name: d.name, description: d.description ?? null, categoryId: d.categoryId ?? null, brand: d.brand ?? null, manufacturer: d.manufacturer ?? null,
      barcode: ids.barcode, unit: d.unit, costCents: d.costCents ?? null, sellPriceCents: sellPrice, taxTreatment: d.taxTreatment, minStock: d.minStock,
      reorderLevel: d.reorderLevel ?? null, reorderQuantity, primarySupplierId: d.primarySupplierId ?? null, notes: d.notes ?? null, createdById: ctx.user.id, updatedById: ctx.user.id,
    },
  });
  if (part.primarySupplierId) await tx.partSupplier.create({ data: { businessId: ctx.business.id, partId: part.id, supplierId: part.primarySupplierId, preferred: true, supplierCostCents: part.costCents } });
  await recordPriceChange(tx, ctx.business.id, ctx.user.id, part.id, { previousCost: null, newCost: part.costCents, previousSell: null, newSell: part.sellPriceCents, source });
  await recordAudit(tx, ctx.meta, { action: AuditActions.partCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: part.id, after: { sku: part.sku, name: part.name, costCents: part.costCents, sellPriceCents: part.sellPriceCents }, metadata: { source } });

  if ((d.openingQuantity ?? 0) > 0 || d.bin || d.storageArea) {
    const locationId = await resolveLocation(tx, ctx, d.openingLocationId);
    if (d.bin || d.storageArea) {
      await tx.$executeRaw`INSERT INTO stock_levels (business_id, part_id, location_id, bin, storage_area, updated_at) VALUES (${ctx.business.id}::uuid, ${part.id}::uuid, ${locationId}::uuid, ${d.bin ?? null}, ${d.storageArea ?? null}, now()) ON CONFLICT (part_id, location_id) DO UPDATE SET bin = EXCLUDED.bin, storage_area = EXCLUDED.storage_area`;
    }
    if ((d.openingQuantity ?? 0) > 0) {
      requirePermission(ctx, 'inventory.adjust');
      await applyMovement(tx, actorOf(ctx), { partId: part.id, locationId, type: 'ADJUSTED', onHandDelta: d.openingQuantity!, referenceType: 'adjustment', reasonCode: 'OPENING_BALANCE', reason: 'Opening balance when the part was added' }, { settings });
    }
  }
  return part;
}

export async function createPart(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.create');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(partCreateSchema, input);
  if ((d.costCents != null) && !canSeeCosts(ctx)) throw Errors.forbidden('You do not have permission to enter part costs.');
  if ((d.openingQuantity ?? 0) > 0) requirePermission(ctx, 'inventory.adjust');
  return withTenant(ctx.business.id, async (tx) => {
    const p = await createPartTx(tx, ctx, d);
    return { id: p.id, sku: p.sku };
  });
}

export async function updatePart(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  const { reason, ...d } = parseOrThrow(partUpdateSchema, input);
  if (d.costCents !== undefined && !canSeeCosts(ctx)) throw Errors.forbidden('You do not have permission to change part costs.');
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.part.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Part');
    if (before.status === 'ARCHIVED') throw Errors.conflict('This part is archived. Restore it to edit it.');
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const next = {
      sku: d.sku !== undefined ? d.sku : before.sku,
      partNumber: d.partNumber !== undefined ? d.partNumber : before.partNumber,
      barcode: d.barcode !== undefined ? d.barcode : before.barcode,
    };
    if (!next.sku) throw Errors.validation({ sku: 'A part needs a SKU.' });
    await assertIdentifiersFree(tx, ctx.business.id, settings, { sku: next.sku !== before.sku ? next.sku : null, partNumber: next.partNumber !== before.partNumber ? next.partNumber : null, barcode: next.barcode !== before.barcode ? next.barcode : null }, id);
    await assertRefs(tx, ctx.business.id, d);
    const data = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
    const after = await tx.part.update({ where: { id }, data: { ...data, updatedById: ctx.user.id } });
    const changed = Object.keys(data).filter((k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
    if (d.primarySupplierId) {
      await tx.partSupplier.updateMany({ where: { partId: id, businessId: ctx.business.id, supplierId: { not: d.primarySupplierId } }, data: { preferred: false } });
      await tx.partSupplier.upsert({ where: { partId_supplierId: { partId: id, supplierId: d.primarySupplierId } }, create: { businessId: ctx.business.id, partId: id, supplierId: d.primarySupplierId, preferred: true }, update: { preferred: true, status: 'ACTIVE' } });
    }
    const priced = await recordPriceChange(tx, ctx.business.id, ctx.user.id, id, { previousCost: before.costCents, newCost: after.costCents, previousSell: before.sellPriceCents, newSell: after.sellPriceCents, source: 'MANUAL', reason });
    if (changed.length) {
      await recordAudit(tx, ctx.meta, {
        action: priced ? AuditActions.partPriceChanged : AuditActions.partUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: id,
        before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])), metadata: { sku: after.sku, reason: reason ?? null },
      });
      if (priced && changed.some((k) => k !== 'costCents' && k !== 'sellPriceCents')) {
        await recordAudit(tx, ctx.meta, { action: AuditActions.partUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: id, metadata: { sku: after.sku, fields: changed } });
      }
    }
    return { id: after.id, sku: after.sku };
  });
}

/**
 * Parts are never deleted (jobs, invoices, purchase orders and stock history point at them). INACTIVE = hidden from new
 * jobs and orders but still visible; ARCHIVED = out of the way. A part with stock on the shelf or reserved cannot be archived.
 */
export async function setPartStatus(ctx: BusinessContext, id: string, status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED', reason?: string) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  parseOrThrow(z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']), status);
  return withTenant(ctx.business.id, async (tx) => {
    const p = await tx.part.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!p) throw Errors.notFound('Part');
    if (p.status === status) return { id, status };
    if (status === 'ARCHIVED') {
      const sums = await tx.stockLevel.aggregate({ where: { businessId: ctx.business.id, partId: id }, _sum: { onHand: true, reserved: true } });
      if ((sums._sum.reserved ?? 0) > 0) throw Errors.conflict('This part is reserved for a job. Release the reservations first.');
      if ((sums._sum.onHand ?? 0) !== 0) throw Errors.conflict('This part still has stock. Adjust or transfer the stock first, or mark it inactive instead.');
    }
    await tx.part.update({ where: { id }, data: { status, archivedAt: status === 'ARCHIVED' ? new Date() : null, updatedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, {
      action: status === 'ARCHIVED' ? AuditActions.partArchived : status === 'ACTIVE' && p.status === 'ARCHIVED' ? AuditActions.partRestored : AuditActions.partUpdated,
      businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: id, before: { status: p.status }, after: { status }, metadata: { sku: p.sku, reason: reason ?? null },
    });
    return { id, status };
  });
}

// ───────── Reading ─────────

export interface PartRow {
  id: string;
  sku: string;
  partNumber: string | null;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  brand: string | null;
  manufacturer: string | null;
  barcode: string | null;
  unit: string;
  costCents: number | null;
  sellPriceCents: number | null;
  taxTreatment: string;
  minStock: number;
  reorderLevel: number | null;
  reorderQuantity: number | null;
  primarySupplierId: string | null;
  primarySupplierName: string | null;
  status: string;
  notes: string | null;
  onHand: number;
  reserved: number;
  available: number;
  state: StockState;
  createdAt: Date;
  updatedAt: Date;
}

type PartWithRefs = Awaited<ReturnType<Tx['part']['findFirstOrThrow']>> & { category?: { name: string } | null; primarySupplier?: { name: string } | null };

export function toPartRow(ctx: BusinessContext, p: PartWithRefs, totals: { onHand: number; reserved: number }): PartRow {
  const available = availableOf(totals.onHand, totals.reserved);
  return {
    id: p.id, sku: p.sku, partNumber: p.partNumber, name: p.name, description: p.description, categoryId: p.categoryId, categoryName: p.category?.name ?? null, brand: p.brand, manufacturer: p.manufacturer,
    barcode: p.barcode, unit: p.unit, costCents: canSeeCosts(ctx) ? p.costCents : null, sellPriceCents: p.sellPriceCents, taxTreatment: p.taxTreatment, minStock: p.minStock, reorderLevel: p.reorderLevel,
    reorderQuantity: p.reorderQuantity, primarySupplierId: p.primarySupplierId, primarySupplierName: p.primarySupplier?.name ?? null, status: p.status, notes: p.notes,
    onHand: totals.onHand, reserved: totals.reserved, available, state: stockState(available, p.minStock, p.reorderLevel), createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

export const partListSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED', 'all']).optional(),
  categoryId: uuidSchema.optional(),
  supplierId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  stock: z.enum(['in', 'low', 'out', 'reserved']).optional(),
  minAvailable: z.coerce.number().int().min(-1_000_000).max(10_000_000).optional(),
  maxAvailable: z.coerce.number().int().min(-1_000_000).max(10_000_000).optional(),
  compatibleWith: uuidSchema.optional(),
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  sort: z.enum(['name', 'sku', 'available', 'on_hand', 'updated', 'created']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

function compatCondition(f: VehicleFacts): Prisma.Sql {
  const t = (col: string, v: string | null | undefined) => Prisma.sql`(${Prisma.raw(col)} IS NULL OR (${v ?? null}::text IS NOT NULL AND lower(${Prisma.raw(col)}) = lower(${v ?? null}::text)))`;
  return Prisma.sql`EXISTS (SELECT 1 FROM part_compatibility pc WHERE pc.part_id = p.id AND ${t('pc.make', f.make)} AND ${t('pc.model', f.model)} AND ${t('pc.variant', f.variant)} AND ${t('pc.engine', f.engine)}
    AND ${t('pc.fuel_type::text', f.fuelType)} AND ${t('pc.transmission::text', f.transmission)}
    AND (pc.engine_size_cc IS NULL OR (${f.engineSizeCc ?? null}::int IS NOT NULL AND pc.engine_size_cc = ${f.engineSizeCc ?? null}::int))
    AND (pc.year_from IS NULL OR (${f.year ?? null}::int IS NOT NULL AND ${f.year ?? null}::int >= pc.year_from))
    AND (pc.year_to IS NULL OR (${f.year ?? null}::int IS NOT NULL AND ${f.year ?? null}::int <= pc.year_to)))`;
}

/**
 * Search and filter the catalogue, a page at a time, by name, SKU, part number, barcode, brand, manufacturer, supplier part
 * number, category or compatible make/model. Stock figures count only the caller's locations, and so do the stock filters,
 * so no count leaks from a location they cannot use.
 */
export async function listParts(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(partListSchema, query);
  const bid = ctx.business.id;
  return withTenant(bid, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const conds: Prisma.Sql[] = [Prisma.sql`p.business_id = ${bid}::uuid`];
    if (q.status === 'all') {
      /* everything */
    } else if (q.status) conds.push(Prisma.sql`p.status = ${q.status}::inventory_status`);
    else conds.push(Prisma.sql`p.status <> 'ARCHIVED'`);
    if (q.categoryId) conds.push(Prisma.sql`(p.category_id = ${q.categoryId}::uuid OR p.category_id IN (SELECT id FROM part_categories WHERE parent_id = ${q.categoryId}::uuid AND business_id = ${bid}::uuid))`);
    if (q.supplierId) conds.push(Prisma.sql`(p.primary_supplier_id = ${q.supplierId}::uuid OR EXISTS (SELECT 1 FROM part_suppliers ps WHERE ps.part_id = p.id AND ps.supplier_id = ${q.supplierId}::uuid AND ps.status = 'ACTIVE'))`);
    if (q.locationId) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM stock_levels sl WHERE sl.part_id = p.id AND sl.location_id = ${q.locationId}::uuid AND (sl.on_hand <> 0 OR sl.reserved <> 0 OR sl.bin IS NOT NULL))`);
    for (const word of (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6)) {
      const like = `%${escapeLike(word)}%`;
      conds.push(Prisma.sql`(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR p.part_number ILIKE ${like} OR p.barcode ILIKE ${like} OR p.brand ILIKE ${like} OR p.manufacturer ILIKE ${like}
        OR EXISTS (SELECT 1 FROM part_suppliers ps WHERE ps.part_id = p.id AND ps.supplier_part_number ILIKE ${like})
        OR EXISTS (SELECT 1 FROM part_categories c WHERE c.id = p.category_id AND c.name ILIKE ${like})
        OR EXISTS (SELECT 1 FROM part_compatibility pc WHERE pc.part_id = p.id AND (pc.make ILIKE ${like} OR pc.model ILIKE ${like})))`);
    }
    let facts: VehicleFacts | null = null;
    if (q.compatibleWith) {
      const v = await tx.vehicle.findFirst({ where: { id: q.compatibleWith, businessId: bid } });
      if (!v) throw Errors.validation({ compatibleWith: 'Choose a vehicle of this business.' });
      facts = { make: v.make, model: v.model, year: v.year, variant: v.variant, engine: v.engine, engineSizeCc: v.engineSizeCc, fuelType: v.fuelType, transmission: v.transmission };
    } else if (q.make || q.model || q.year) {
      facts = { make: q.make, model: q.model, year: q.year };
    }
    if (facts) conds.push(compatCondition(facts));

    const outer: Prisma.Sql[] = [];
    const avail = Prisma.sql`(t.on_hand - t.reserved)`;
    if (q.stock === 'out') outer.push(Prisma.sql`${avail} <= 0`);
    if (q.stock === 'in') outer.push(Prisma.sql`${avail} > 0`);
    if (q.stock === 'reserved') outer.push(Prisma.sql`t.reserved > 0`);
    if (q.stock === 'low') outer.push(Prisma.sql`${avail} > 0 AND GREATEST(t.min_stock, COALESCE(t.reorder_level, 0)) > 0 AND ${avail} <= GREATEST(t.min_stock, COALESCE(t.reorder_level, 0))`);
    if (q.minAvailable !== undefined) outer.push(Prisma.sql`${avail} >= ${q.minAvailable}`);
    if (q.maxAvailable !== undefined) outer.push(Prisma.sql`${avail} <= ${q.maxAvailable}`);

    const dirSql = q.dir === 'desc' ? Prisma.raw('DESC') : Prisma.raw('ASC');
    const order = {
      name: Prisma.sql`lower(t.name) ${dirSql}, t.sku ASC`, sku: Prisma.sql`lower(t.sku) ${dirSql}`, available: Prisma.sql`${avail} ${dirSql}, lower(t.name) ASC`,
      on_hand: Prisma.sql`t.on_hand ${dirSql}, lower(t.name) ASC`, updated: Prisma.sql`t.updated_at ${dirSql}`, created: Prisma.sql`t.created_at ${dirSql}`,
    }[q.sort];

    const rows = await tx.$queryRaw<{ id: string; on_hand: number; reserved: number; total: bigint }[]>`
      SELECT t.id, t.on_hand, t.reserved, count(*) OVER() AS total FROM (
        SELECT p.id, p.name, p.sku, p.min_stock, p.reorder_level, p.updated_at, p.created_at,
               COALESCE((SELECT sum(sl.on_hand) FROM stock_levels sl WHERE sl.part_id = p.id AND sl.business_id = ${bid}::uuid AND sl.location_id = ANY(${locs}::uuid[])), 0)::int AS on_hand,
               COALESCE((SELECT sum(sl.reserved) FROM stock_levels sl WHERE sl.part_id = p.id AND sl.business_id = ${bid}::uuid AND sl.location_id = ANY(${locs}::uuid[])), 0)::int AS reserved
          FROM parts p WHERE ${Prisma.join(conds, ' AND ')}
      ) t
      ${outer.length ? Prisma.sql`WHERE ${Prisma.join(outer, ' AND ')}` : Prisma.empty}
      ORDER BY ${order}, t.id
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const total = rows.length ? Number(rows[0]!.total) : 0;
    const ids = rows.map((r) => r.id);
    const parts = await tx.part.findMany({ where: { id: { in: ids }, businessId: bid }, include: { category: { select: { name: true } }, primarySupplier: { select: { name: true } } } });
    const byId = new Map(parts.map((p) => [p.id, p]));
    const items = rows.flatMap((r) => {
      const p = byId.get(r.id);
      return p ? [toPartRow(ctx, p, { onHand: r.on_hand, reserved: r.reserved })] : [];
    });
    // A page past the end of the results still reports the real total.
    const meta = pageMeta(q.page, q.pageSize, total || (q.page > 1 ? await countParts(tx, bid, conds, outer, locs) : 0));
    return { items, meta };
  });
}

async function countParts(tx: Tx, bid: string, conds: Prisma.Sql[], outer: Prisma.Sql[], locs: string[]): Promise<number> {
  const r = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM (
      SELECT p.id, p.min_stock, p.reorder_level,
             COALESCE((SELECT sum(sl.on_hand) FROM stock_levels sl WHERE sl.part_id = p.id AND sl.business_id = ${bid}::uuid AND sl.location_id = ANY(${locs}::uuid[])), 0)::int AS on_hand,
             COALESCE((SELECT sum(sl.reserved) FROM stock_levels sl WHERE sl.part_id = p.id AND sl.business_id = ${bid}::uuid AND sl.location_id = ANY(${locs}::uuid[])), 0)::int AS reserved
        FROM parts p WHERE ${Prisma.join(conds, ' AND ')}) t
    ${outer.length ? Prisma.sql`WHERE ${Prisma.join(outer, ' AND ')}` : Prisma.empty}`;
  return Number(r[0]?.n ?? 0);
}

/** Barcode, SKU or part number typed or scanned: exact matches (case-insensitive), barcode first. */
export async function findPartByCode(ctx: BusinessContext, code: string) {
  requirePermission(ctx, 'inventory.view');
  const c = parseOrThrow(z.string().trim().min(1).max(100), code);
  return withTenant(ctx.business.id, async (tx) => {
    const hit = async (field: 'barcode' | 'sku' | 'partNumber') =>
      tx.part.findMany({ where: { businessId: ctx.business.id, status: { not: 'ARCHIVED' }, [field]: { equals: c, mode: 'insensitive' } }, include: { category: { select: { name: true } }, primarySupplier: { select: { name: true } } }, take: 10 });
    let parts = await hit('barcode');
    let matchedOn = 'barcode';
    if (parts.length === 0) { parts = await hit('sku'); matchedOn = 'sku'; }
    if (parts.length === 0) { parts = await hit('partNumber'); matchedOn = 'part number'; }
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const stock = await stockForParts(tx, ctx.business.id, parts.map((p) => p.id), locs);
    return { matchedOn, items: parts.map((p) => toPartRow(ctx, p, totalsFor(stock, p.id))) };
  });
}

export async function getPart(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, id);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const p = await tx.part.findFirst({ where: { id, businessId: ctx.business.id }, include: { category: { select: { name: true } }, primarySupplier: { select: { name: true } } } });
    if (!p) throw Errors.notFound('Part');
    const locs = await accessibleLocations(tx, ctx);
    const levels = await tx.stockLevel.findMany({ where: { businessId: ctx.business.id, partId: id, locationId: { in: locs.map((l) => l.id) } } });
    const byLoc = new Map(levels.map((l) => [l.locationId, l]));
    const stockRows = locs.map((l) => {
      const lv = byLoc.get(l.id);
      return { locationId: l.id, locationName: l.name, isDefault: l.isDefault, onHand: lv?.onHand ?? 0, reserved: lv?.reserved ?? 0, available: availableOf(lv?.onHand ?? 0, lv?.reserved ?? 0), bin: lv?.bin ?? null, storageArea: lv?.storageArea ?? null };
    });
    const totals = { onHand: stockRows.reduce((s, r) => s + r.onHand, 0), reserved: stockRows.reduce((s, r) => s + r.reserved, 0) };
    const row = toPartRow(ctx, p, totals);
    const [compat, suppliers, lastMovement, onOrder] = [
      await tx.partCompatibility.findMany({ where: { businessId: ctx.business.id, partId: id }, orderBy: [{ make: 'asc' }, { model: 'asc' }, { yearFrom: 'asc' }] }),
      await tx.partSupplier.findMany({ where: { businessId: ctx.business.id, partId: id }, include: { supplier: { select: { id: true, name: true, status: true } } }, orderBy: [{ preferred: 'desc' }, { createdAt: 'asc' }] }),
      await tx.stockMovement.findFirst({ where: { businessId: ctx.business.id, partId: id, locationId: { in: locs.map((l) => l.id) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, type: true } }),
      await tx.purchaseOrderLine.findMany({ where: { businessId: ctx.business.id, partId: id, order: { status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } } }, select: { quantityOrdered: true, quantityReceived: true, quantityCancelled: true } }),
    ];
    const createdBy = (await userNames(tx, [p.createdById, p.updatedById]));
    return {
      part: row,
      stock: stockRows,
      onOrder: onOrder.reduce((s, l) => s + l.quantityOrdered - l.quantityReceived - l.quantityCancelled, 0),
      suggestedReorder: suggestedReorder(row.available, p.minStock, p.reorderLevel, p.reorderQuantity),
      compatibility: compat,
      suppliers: suppliers.map((s) => ({ id: s.id, supplierId: s.supplierId, supplierName: s.supplier.name, supplierStatus: s.supplier.status, supplierPartNumber: s.supplierPartNumber, supplierCostCents: costs ? s.supplierCostCents : null, leadTimeDays: s.leadTimeDays, preferred: s.preferred, status: s.status })),
      lastMovement,
      createdByName: p.createdById ? (createdBy.get(p.createdById) ?? null) : null,
      updatedByName: p.updatedById ? (createdBy.get(p.updatedById) ?? null) : null,
      canSeeCosts: costs,
    };
  });
}

export async function listPartJobs(ctx: BusinessContext, id: string, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  requirePermission(ctx, 'job.view');
  parseOrThrow(uuidSchema, id);
  const q = parseOrThrow(paginationSchema, query);
  const pricing = can(ctx, 'job.view_pricing');
  return withTenant(ctx.business.id, async (tx) => {
    const where = { businessId: ctx.business.id, inventoryItemId: id, archivedAt: null };
    const total = await tx.jobPart.count({ where });
    const rows = await tx.jobPart.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { job: { select: { id: true, jobNumber: true, status: true, vehicle: { select: { registration: true } } } } } });
    return {
      items: rows.map((r) => ({ id: r.id, jobId: r.job.id, jobNumber: r.job.jobNumber, jobStatus: r.job.status, registration: r.job.vehicle.registration, quantity: r.quantity, status: r.status, sellPriceCents: pricing ? r.sellPriceCents : null, costCents: pricing && canSeeCosts(ctx) ? r.costCents : null, createdAt: r.createdAt, fittedAt: r.fittedAt })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function listPartPurchases(ctx: BusinessContext, id: string, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, id);
  const q = parseOrThrow(paginationSchema, query);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const where = { businessId: ctx.business.id, partId: id, receipt: { locationId: { in: locs } } };
    const total = await tx.goodsReceiptLine.count({ where });
    const rows = await tx.goodsReceiptLine.findMany({ where, orderBy: { receipt: { receivedAt: 'desc' } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { receipt: { select: { id: true, number: true, receivedAt: true, purchaseOrderId: true, supplierId: true } } } });
    const suppliers = new Map((await tx.supplier.findMany({ where: { businessId: ctx.business.id, id: { in: [...new Set(rows.map((r) => r.receipt.supplierId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const orders = new Map((await tx.purchaseOrder.findMany({ where: { businessId: ctx.business.id, id: { in: [...new Set(rows.map((r) => r.receipt.purchaseOrderId))] } }, select: { id: true, number: true } })).map((o) => [o.id, o.number]));
    return {
      items: rows.map((r) => ({ id: r.id, receiptId: r.receipt.id, receiptNumber: r.receipt.number, receivedAt: r.receipt.receivedAt, orderId: r.receipt.purchaseOrderId, orderNumber: orders.get(r.receipt.purchaseOrderId) ?? '', supplierName: suppliers.get(r.receipt.supplierId) ?? '', quantityReceived: r.quantityReceived, quantityDamaged: r.quantityDamaged, quantityReturned: r.quantityReturned, unitCostCents: costs ? r.unitCostCents : null })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function listPartPrices(ctx: BusinessContext, id: string, query: unknown) {
  requirePermission(ctx, 'inventory.view_costs');
  parseOrThrow(uuidSchema, id);
  const q = parseOrThrow(paginationSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const where = { businessId: ctx.business.id, partId: id };
    const total = await tx.partPriceHistory.count({ where });
    const rows = await tx.partPriceHistory.findMany({ where, orderBy: { changedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize });
    const names = await userNames(tx, rows.map((r) => r.changedById));
    return { items: rows.map((r) => ({ ...r, changedByName: r.changedById ? (names.get(r.changedById) ?? null) : null })), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

// ───────── Compatibility ─────────

export const compatSchema = z.object({
  make: clearable(60), model: clearable(60), yearFrom: optionalQty, yearTo: optionalQty, variant: clearable(60), engine: clearable(60), engineSizeCc: optionalQty,
  fuelType: z.union([z.literal(''), z.null(), z.enum(['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'LPG', 'OTHER'])]).optional().transform((v) => (v ? v : null)),
  transmission: z.union([z.literal(''), z.null(), z.enum(['MANUAL', 'AUTOMATIC', 'CVT', 'DCT', 'OTHER'])]).optional().transform((v) => (v ? v : null)),
  notes: clearable(300),
}).refine((d) => d.make || d.model || d.variant || d.engine || d.engineSizeCc != null || d.yearFrom != null || d.yearTo != null || d.fuelType || d.transmission, { message: 'Name at least one vehicle attribute.' })
  .refine((d) => d.yearFrom == null || d.yearTo == null || d.yearFrom <= d.yearTo, { message: 'The first year cannot be after the last year.', path: ['yearTo'] });

export async function addCompatibility(ctx: BusinessContext, partId: string, input: unknown) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, partId);
  const d = parseOrThrow(compatSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const p = await tx.part.findFirst({ where: { id: partId, businessId: ctx.business.id }, select: { id: true, sku: true } });
    if (!p) throw Errors.notFound('Part');
    const row = await tx.partCompatibility.create({ data: { businessId: ctx.business.id, partId, make: d.make ?? null, model: d.model ?? null, yearFrom: d.yearFrom ?? null, yearTo: d.yearTo ?? null, variant: d.variant ?? null, engine: d.engine ?? null, engineSizeCc: d.engineSizeCc ?? null, fuelType: d.fuelType, transmission: d.transmission, notes: d.notes ?? null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.partCompatibilityChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: partId, metadata: { change: 'added', sku: p.sku, make: d.make, model: d.model } });
    return row;
  });
}

export async function removeCompatibility(ctx: BusinessContext, partId: string, ruleId: string) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, partId);
  parseOrThrow(uuidSchema, ruleId);
  return withTenant(ctx.business.id, async (tx) => {
    const r = await tx.partCompatibility.findFirst({ where: { id: ruleId, partId, businessId: ctx.business.id } });
    if (!r) throw Errors.notFound('Compatibility entry');
    await tx.partCompatibility.delete({ where: { id: ruleId } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.partCompatibilityChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: partId, metadata: { change: 'removed', make: r.make, model: r.model } });
  });
}

/** Parts known to fit a vehicle of this business (a search aid; the technician decides what fits). */
export async function partsForVehicle(ctx: BusinessContext, vehicleId: string, query: unknown = {}) {
  const v = vehicleId;
  const r = await listParts(ctx, { ...(query as object), compatibleWith: v, pageSize: 50 });
  return r;
}

export const vehicleFactsLabel = (v: { registration?: string | null; make?: string | null; model?: string | null }) => vehicleLabel(v);

// ───────── Part ↔ supplier ─────────

export const partSupplierSchema = z.object({
  supplierId: uuidSchema,
  supplierPartNumber: clearable(80),
  supplierCostCents: cents,
  leadTimeDays: optionalQty,
  preferred: z.boolean().optional(),
});

export async function linkSupplier(ctx: BusinessContext, partId: string, input: unknown) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, partId);
  const d = parseOrThrow(partSupplierSchema, input);
  if (d.supplierCostCents != null && !canSeeCosts(ctx)) throw Errors.forbidden('You do not have permission to enter supplier costs.');
  return withTenant(ctx.business.id, async (tx) => {
    const p = await tx.part.findFirst({ where: { id: partId, businessId: ctx.business.id }, select: { id: true, sku: true, primarySupplierId: true } });
    if (!p) throw Errors.notFound('Part');
    const s = await tx.supplier.findFirst({ where: { id: d.supplierId, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true, name: true } });
    if (!s) throw Errors.validation({ supplierId: 'Choose an active supplier of this business.' });
    const existing = await tx.partSupplier.findUnique({ where: { partId_supplierId: { partId, supplierId: d.supplierId } } });
    const data = { supplierPartNumber: d.supplierPartNumber ?? null, supplierCostCents: d.supplierCostCents ?? null, leadTimeDays: d.leadTimeDays ?? null, status: 'ACTIVE' as const, ...(d.preferred !== undefined ? { preferred: d.preferred } : {}) };
    const row = existing
      ? await tx.partSupplier.update({ where: { id: existing.id }, data })
      : await tx.partSupplier.create({ data: { businessId: ctx.business.id, partId, supplierId: d.supplierId, ...data } });
    if (d.preferred) {
      await tx.partSupplier.updateMany({ where: { partId, businessId: ctx.business.id, id: { not: row.id } }, data: { preferred: false } });
      await tx.part.update({ where: { id: partId }, data: { primarySupplierId: d.supplierId, updatedById: ctx.user.id } });
    } else if (!p.primarySupplierId) {
      await tx.part.update({ where: { id: partId }, data: { primarySupplierId: d.supplierId } });
    }
    await recordAudit(tx, ctx.meta, { action: AuditActions.partSupplierChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: partId, before: existing ? { supplierCostCents: existing.supplierCostCents, supplierPartNumber: existing.supplierPartNumber } : undefined, after: { supplierId: d.supplierId, supplierCostCents: row.supplierCostCents, supplierPartNumber: row.supplierPartNumber, preferred: row.preferred }, metadata: { sku: p.sku, supplier: s.name } });
    return row;
  });
}

/** A supplier link is switched off rather than deleted, so purchase history keeps its context. */
export async function unlinkSupplier(ctx: BusinessContext, partId: string, supplierId: string) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, partId);
  parseOrThrow(uuidSchema, supplierId);
  return withTenant(ctx.business.id, async (tx) => {
    const link = await tx.partSupplier.findFirst({ where: { partId, supplierId, businessId: ctx.business.id } });
    if (!link) throw Errors.notFound('Supplier link');
    await tx.partSupplier.update({ where: { id: link.id }, data: { status: 'INACTIVE', preferred: false } });
    await tx.part.updateMany({ where: { id: partId, businessId: ctx.business.id, primarySupplierId: supplierId }, data: { primarySupplierId: null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.partSupplierChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: partId, metadata: { change: 'removed', supplierId } });
  });
}

// ───────── Activity ─────────

/** Edits, price changes and status changes of one part, newest first: field names and reasons, never old or new values. */
export async function listPartActivity(ctx: BusinessContext, id: string, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, id);
  const q = parseOrThrow(paginationSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    if (!(await tx.part.findFirst({ where: { id, businessId: ctx.business.id }, select: { id: true } }))) throw Errors.notFound('Part');
    const where = { businessId: ctx.business.id, resourceType: 'part', resourceId: id, action: { not: { startsWith: 'stock.' } } };
    const total = await tx.auditLog.count({ where });
    const rows = await tx.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize });
    const names = await userNames(tx, rows.map((r) => r.userId));
    const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v as object) : []);
    return {
      items: rows.map((r) => ({ id: r.id, action: r.action, at: r.createdAt, by: r.userId ? (names.get(r.userId) ?? null) : null, fields: [...new Set([...keys(r.before), ...keys(r.after)])].filter((k) => canSeeCosts(ctx) || !/cost/i.test(k)), reason: (r.metadata as { reason?: string } | null)?.reason ?? null })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}
