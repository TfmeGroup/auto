import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { dayRange } from '@/lib/tz';
import { optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { availableOf, stockState } from './calc';
import { accessibleLocations, actorOf, guardStock, hideCosts, loadInventorySettings, resolveLocation, scopedLocationIds, type Actor, type InventorySettingsRow } from './common';

/**
 * The stock ledger. Every change to a quantity is one row in stock_movements, and the database applies that row to the
 * stock level under the level's row lock (see migration 0008): the count can never be edited directly, can never drift from
 * its history, and two requests for the last unit are decided one after the other, whatever the application checked first.
 *
 *   on hand    what is physically there
 *   reserved   promised to a job but not yet used
 *   available  on hand - reserved   (what can still be promised)
 */

export type MovementType = 'RECEIVED' | 'SOLD' | 'USED' | 'RESERVED' | 'UNRESERVED' | 'RETURNED' | 'ADJUSTED' | 'DAMAGED' | 'LOST' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'SUPPLIER_RETURN';
export const MOVEMENT_TYPES: MovementType[] = ['RECEIVED', 'SOLD', 'USED', 'RESERVED', 'UNRESERVED', 'RETURNED', 'ADJUSTED', 'DAMAGED', 'LOST', 'TRANSFER_IN', 'TRANSFER_OUT', 'SUPPLIER_RETURN'];
export const MOVEMENT_LABEL: Record<MovementType, string> = {
  RECEIVED: 'Received', SOLD: 'Sold', USED: 'Used on a job', RESERVED: 'Reserved', UNRESERVED: 'Reservation released', RETURNED: 'Returned to stock', ADJUSTED: 'Adjusted',
  DAMAGED: 'Damaged', LOST: 'Lost / missing', TRANSFER_IN: 'Transferred in', TRANSFER_OUT: 'Transferred out', SUPPLIER_RETURN: 'Returned to supplier',
};

export interface MovementInput {
  partId: string;
  locationId: string;
  type: MovementType;
  onHandDelta: number;
  reservedDelta?: number;
  unitCostCents?: number | null;
  referenceType?: string;
  referenceId?: string;
  jobId?: string | null;
  jobPartId?: string | null;
  invoiceId?: string | null;
  purchaseOrderId?: string | null;
  receiptId?: string | null;
  transferId?: string | null;
  reasonCode?: string;
  reason?: string;
  idempotencyKey?: string;
}

export type MovementRow = Awaited<ReturnType<Tx['stockMovement']['create']>>;

/** Make sure the (part, location) stock row exists and lock it for the rest of the transaction. Returns what is there now. */
export async function lockStockLevel(tx: Tx, businessId: string, partId: string, locationId: string): Promise<{ onHand: number; reserved: number }> {
  const part = await tx.part.findFirst({ where: { id: partId, businessId }, select: { id: true } });
  if (!part) throw Errors.notFound('Part');
  const loc = await tx.location.findFirst({ where: { id: locationId, businessId }, select: { id: true } });
  if (!loc) throw Errors.validation({ locationId: 'Choose a location of this business.' });
  await tx.$executeRaw`INSERT INTO stock_levels (business_id, part_id, location_id, updated_at) VALUES (${businessId}::uuid, ${partId}::uuid, ${locationId}::uuid, now()) ON CONFLICT (part_id, location_id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ on_hand: number; reserved: number; business_id: string }[]>`
    SELECT on_hand, reserved, business_id FROM stock_levels WHERE part_id = ${partId}::uuid AND location_id = ${locationId}::uuid FOR UPDATE`;
  const r = rows[0];
  if (!r || r.business_id !== businessId) throw Errors.notFound('Stock');
  return { onHand: r.on_hand, reserved: r.reserved };
}

const AUDIT_FOR: Partial<Record<MovementType, string>> = {
  RECEIVED: AuditActions.stockReceived, SOLD: AuditActions.stockSold, USED: AuditActions.stockUsed, RESERVED: AuditActions.stockReserved, UNRESERVED: AuditActions.stockUnreserved,
  RETURNED: AuditActions.stockReturned, ADJUSTED: AuditActions.stockAdjusted, DAMAGED: AuditActions.stockDamaged, LOST: AuditActions.stockLost,
};

export interface ApplyOptions {
  settings?: InventorySettingsRow;
  /** false = even if the business allows negative stock, this caller may not use it (manual adjustments without the permission). */
  canGoNegative?: boolean;
}

/**
 * Record one stock movement. Locks the stock level, checks the request against what is really there NOW (not what the page
 * showed), and inserts the movement; the database applies it. Replaying the same idempotency key returns the first result.
 */
export async function applyMovement(tx: Tx, actor: Actor, m: MovementInput, opts: ApplyOptions = {}): Promise<{ movement: MovementRow; replayed: boolean }> {
  if (!Number.isInteger(m.onHandDelta) || !Number.isInteger(m.reservedDelta ?? 0)) throw Errors.validation({ quantity: 'Quantities are whole numbers.' });
  const settings = opts.settings ?? (await loadInventorySettings(tx, actor.businessId));
  const part = await tx.part.findFirst({ where: { id: m.partId, businessId: actor.businessId }, select: { id: true, sku: true, name: true, costCents: true } });
  if (!part) throw Errors.notFound('Part');
  const level = await lockStockLevel(tx, actor.businessId, m.partId, m.locationId);

  if (m.idempotencyKey) {
    const prior = await tx.stockMovement.findFirst({ where: { businessId: actor.businessId, idempotencyKey: m.idempotencyKey } });
    if (prior) {
      if (prior.partId !== m.partId || prior.type !== m.type || prior.onHandDelta !== m.onHandDelta) throw Errors.conflict('That request key was already used for a different stock change.');
      return { movement: prior, replayed: true };
    }
  }

  const reservedDelta = m.reservedDelta ?? 0;
  const availableAfter = availableOf(level.onHand + m.onHandDelta, level.reserved + reservedDelta);
  const reducesAvailability = m.onHandDelta - reservedDelta < 0;
  if (reducesAvailability && availableAfter < 0) {
    const negativeOk = settings.allowNegativeStock && (opts.canGoNegative ?? true);
    if (!negativeOk) {
      const available = availableOf(level.onHand, level.reserved);
      throw Errors.conflict(
        `Not enough stock of ${part.sku}: ${Math.max(0, available)} available (${level.onHand} on hand, ${level.reserved} reserved).`,
        { code: 'INSUFFICIENT_STOCK', partId: m.partId, available, onHand: level.onHand, reserved: level.reserved },
      );
    }
  }

  const movement = await guardStock(() =>
    tx.stockMovement.create({
      data: {
        businessId: actor.businessId, partId: m.partId, locationId: m.locationId, type: m.type, onHandDelta: m.onHandDelta, reservedDelta,
        unitCostCents: m.unitCostCents === undefined ? part.costCents : m.unitCostCents,
        referenceType: m.referenceType ?? null, referenceId: m.referenceId ?? null, jobId: m.jobId ?? null, jobPartId: m.jobPartId ?? null, invoiceId: m.invoiceId ?? null,
        purchaseOrderId: m.purchaseOrderId ?? null, receiptId: m.receiptId ?? null, transferId: m.transferId ?? null,
        reasonCode: m.reasonCode ?? null, reason: m.reason ?? null, idempotencyKey: m.idempotencyKey ?? null, createdById: actor.userId,
      },
    }),
  );

  const action = AUDIT_FOR[m.type];
  const detail = {
    partId: m.partId, sku: part.sku, locationId: m.locationId, onHandDelta: m.onHandDelta, reservedDelta, onHandBefore: movement.onHandBefore, onHandAfter: movement.onHandAfter,
    reservedBefore: movement.reservedBefore, reservedAfter: movement.reservedAfter, referenceType: m.referenceType ?? null, referenceId: m.referenceId ?? null, jobId: m.jobId ?? null,
    reasonCode: m.reasonCode ?? null, reason: m.reason ?? null,
  };
  if (action) await recordAudit(tx, actor.meta, { action, businessId: actor.businessId, userId: actor.userId, resourceType: 'part', resourceId: m.partId, metadata: detail });
  if (movement.wentNegative) await recordAudit(tx, actor.meta, { action: AuditActions.stockWentNegative, businessId: actor.businessId, userId: actor.userId, resourceType: 'part', resourceId: m.partId, metadata: detail });
  return { movement, replayed: false };
}

// ───────── Reading stock ─────────

export interface StockTotals { onHand: number; reserved: number }

/** Totals per part over the given locations only (a member never sees counts from a location they cannot use). */
export async function stockForParts(tx: Tx, businessId: string, partIds: string[], locationIds: string[]): Promise<Map<string, StockTotals>> {
  const out = new Map<string, StockTotals>();
  if (partIds.length === 0 || locationIds.length === 0) return out;
  const rows = await tx.stockLevel.groupBy({ by: ['partId'], where: { businessId, partId: { in: partIds }, locationId: { in: locationIds } }, _sum: { onHand: true, reserved: true } });
  for (const r of rows) out.set(r.partId, { onHand: r._sum.onHand ?? 0, reserved: r._sum.reserved ?? 0 });
  return out;
}

export const totalsFor = (m: Map<string, StockTotals>, id: string): StockTotals => m.get(id) ?? { onHand: 0, reserved: 0 };

export async function userNames(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const rows = await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Stock for one part by location (only locations the caller may use) with totals and the resulting state. */
export async function getPartStock(ctx: BusinessContext, partId: string) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, partId);
  return withTenant(ctx.business.id, async (tx) => {
    const part = await tx.part.findFirst({ where: { id: partId, businessId: ctx.business.id }, select: { id: true, minStock: true, reorderLevel: true, reorderQuantity: true } });
    if (!part) throw Errors.notFound('Part');
    const locs = await accessibleLocations(tx, ctx);
    const levels = await tx.stockLevel.findMany({ where: { businessId: ctx.business.id, partId, locationId: { in: locs.map((l) => l.id) } } });
    const byLoc = new Map(levels.map((l) => [l.locationId, l]));
    const rows = locs.map((l) => {
      const lv = byLoc.get(l.id);
      const onHand = lv?.onHand ?? 0;
      const reserved = lv?.reserved ?? 0;
      return { locationId: l.id, locationName: l.name, isDefault: l.isDefault, onHand, reserved, available: availableOf(onHand, reserved), bin: lv?.bin ?? null, storageArea: lv?.storageArea ?? null };
    });
    const onHand = rows.reduce((s, r) => s + r.onHand, 0);
    const reserved = rows.reduce((s, r) => s + r.reserved, 0);
    const available = availableOf(onHand, reserved);
    return { locations: rows, onHand, reserved, available, state: stockState(available, part.minStock, part.reorderLevel) };
  });
}

// ───────── Adjustments ─────────

export const ADJUST_REASONS = ['STOCK_COUNT', 'DAMAGED', 'MISSING', 'DATA_CORRECTION', 'OPENING_BALANCE', 'SOLD', 'OTHER'] as const;
export const ADJUST_REASON_LABEL: Record<(typeof ADJUST_REASONS)[number], string> = {
  STOCK_COUNT: 'Stock count correction', DAMAGED: 'Damaged', MISSING: 'Missing / lost', DATA_CORRECTION: 'Data correction', OPENING_BALANCE: 'Opening balance', SOLD: 'Sold over the counter', OTHER: 'Other',
};

export const adjustSchema = z.object({
  partId: uuidSchema,
  locationId: uuidSchema.optional(),
  kind: z.enum(['INCREASE', 'DECREASE', 'COUNT']),
  /** INCREASE / DECREASE: how many. COUNT: how many are actually on the shelf. */
  quantity: z.coerce.number().int('Enter a whole number').min(0, 'Cannot be negative').max(10_000_000),
  reasonCode: z.enum(ADJUST_REASONS),
  reason: z.string().trim().min(3, 'Say why the stock is changing').max(300),
  idempotencyKey: optionalText(100),
});

/**
 * A controlled manual change to stock. A reason is required, the old and new quantity are recorded, and a mistake is corrected
 * by another adjustment (never by editing history). Needs inventory.adjust.
 */
export async function adjustStock(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.adjust');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(adjustSchema, input);
  if (d.kind !== 'COUNT' && d.quantity < 1) throw Errors.validation({ quantity: 'Enter at least 1.' });
  if (d.kind === 'INCREASE' && ['DAMAGED', 'MISSING', 'SOLD'].includes(d.reasonCode)) throw Errors.validation({ reasonCode: 'That reason only applies when stock goes down.' });
  return withTenant(ctx.business.id, async (tx) => {
    const locationId = await resolveLocation(tx, ctx, d.locationId);
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const level = await lockStockLevel(tx, ctx.business.id, d.partId, locationId);
    const delta = d.kind === 'COUNT' ? d.quantity - level.onHand : d.kind === 'INCREASE' ? d.quantity : -d.quantity;
    if (delta === 0) return { unchanged: true as const, onHand: level.onHand, reserved: level.reserved, available: availableOf(level.onHand, level.reserved) };
    const type: MovementType = delta > 0 ? 'ADJUSTED' : d.reasonCode === 'DAMAGED' ? 'DAMAGED' : d.reasonCode === 'MISSING' ? 'LOST' : d.reasonCode === 'SOLD' ? 'SOLD' : 'ADJUSTED';
    const r = await applyMovement(
      tx, actorOf(ctx),
      { partId: d.partId, locationId, type, onHandDelta: delta, referenceType: 'adjustment', reasonCode: d.reasonCode, reason: d.reason, idempotencyKey: d.idempotencyKey },
      { settings, canGoNegative: can(ctx, 'inventory.negative_stock') },
    );
    const m = r.movement;
    return { unchanged: false as const, replayed: r.replayed, movementId: m.id, before: m.onHandBefore, after: m.onHandAfter, onHand: m.onHandAfter, reserved: m.reservedAfter, available: availableOf(m.onHandAfter, m.reservedAfter) };
  });
}

// ───────── Bin / storage area ─────────

export const binSchema = z.object({ locationId: uuidSchema.optional(), bin: optionalText(40), storageArea: optionalText(60) });

export async function setStockBin(ctx: BusinessContext, partId: string, input: unknown) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, partId);
  const d = parseOrThrow(binSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const locationId = await resolveLocation(tx, ctx, d.locationId);
    const part = await tx.part.findFirst({ where: { id: partId, businessId: ctx.business.id }, select: { id: true, sku: true } });
    if (!part) throw Errors.notFound('Part');
    await tx.$executeRaw`INSERT INTO stock_levels (business_id, part_id, location_id, updated_at) VALUES (${ctx.business.id}::uuid, ${partId}::uuid, ${locationId}::uuid, now()) ON CONFLICT (part_id, location_id) DO NOTHING`;
    const before = await tx.stockLevel.findFirstOrThrow({ where: { businessId: ctx.business.id, partId, locationId } });
    const after = await tx.stockLevel.update({ where: { id: before.id }, data: { bin: d.bin ?? null, storageArea: d.storageArea ?? null } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.stockLocationChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part', resourceId: partId,
      before: { bin: before.bin, storageArea: before.storageArea }, after: { bin: after.bin, storageArea: after.storageArea }, metadata: { locationId, sku: part.sku },
    });
    return { bin: after.bin, storageArea: after.storageArea };
  });
}

// ───────── Movement history ─────────

export const movementListSchema = paginationSchema.extend({
  partId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  type: z.string().max(200).optional(),
  jobId: uuidSchema.optional(),
  referenceId: uuidSchema.optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(80).optional(),
});

/** Newest first, paginated, limited to the caller's locations. Costs only for people allowed to see them. */
export async function listMovements(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(movementListSchema, query);
  const types = q.type ? q.type.split(',').map((t) => t.trim().toUpperCase()).filter((t): t is MovementType => (MOVEMENT_TYPES as string[]).includes(t)) : [];
  return withTenant(ctx.business.id, async (tx) => {
    const locs = await scopedLocationIds(tx, ctx, q.locationId);
    const word = q.q?.trim();
    const where = {
      businessId: ctx.business.id,
      locationId: { in: locs },
      ...(q.partId ? { partId: q.partId } : {}),
      ...(types.length ? { type: { in: types } } : {}),
      ...(q.jobId ? { jobId: q.jobId } : {}),
      ...(q.referenceId ? { referenceId: q.referenceId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: dayRange(q.from, ctx.business.timezone).start } : {}), ...(q.to ? { lt: dayRange(q.to, ctx.business.timezone).end } : {}) } } : {}),
      ...(word ? { part: { OR: [{ name: { contains: word, mode: 'insensitive' as const } }, { sku: { contains: word, mode: 'insensitive' as const } }] } } : {}),
    };
    const [total, rows] = [
      await tx.stockMovement.count({ where }),
      await tx.stockMovement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { part: { select: { sku: true, name: true } } } }),
    ];
    const names = await userNames(tx, rows.map((r) => r.createdById));
    const locNames = new Map((await accessibleLocations(tx, ctx)).map((l) => [l.id, l.name]));
    const jobNumbers = new Map(
      (await tx.jobCard.findMany({ where: { businessId: ctx.business.id, id: { in: [...new Set(rows.map((r) => r.jobId).filter((v): v is string => !!v))] } }, select: { id: true, jobNumber: true } })).map((j) => [j.id, j.jobNumber]),
    );
    return {
      items: rows.map((r) =>
        hideCosts(ctx, {
          id: r.id, createdAt: r.createdAt, type: r.type as MovementType, partId: r.partId, sku: r.part.sku, partName: r.part.name, locationId: r.locationId, locationName: locNames.get(r.locationId) ?? '',
          onHandDelta: r.onHandDelta, reservedDelta: r.reservedDelta, onHandBefore: r.onHandBefore, onHandAfter: r.onHandAfter, reservedBefore: r.reservedBefore, reservedAfter: r.reservedAfter,
          unitCostCents: r.unitCostCents as number | null, referenceType: r.referenceType, referenceId: r.referenceId, jobId: r.jobId, jobNumber: r.jobId ? (jobNumbers.get(r.jobId) ?? null) : null,
          purchaseOrderId: r.purchaseOrderId, receiptId: r.receiptId, transferId: r.transferId, reasonCode: r.reasonCode, reason: r.reason, wentNegative: r.wentNegative,
          by: r.createdById ? (names.get(r.createdById) ?? null) : null,
        }, ['unitCostCents']),
      ),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}
