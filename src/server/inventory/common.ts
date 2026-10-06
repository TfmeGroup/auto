import { Errors } from '@/lib/errors';
import { nextNumber } from '@/server/numbering/sequence';
import { can } from '@/server/permissions/authorize';
import { visibleLocationIds } from '@/server/workshop/people';
import type { Tx } from '@/server/db/client';
import type { BusinessContext, RequestMeta } from '@/server/context';

/** Things every inventory service needs: settings, numbering, location access, cost visibility, and the stock-error translation. */

export type InventorySettingsRow = Awaited<ReturnType<Tx['inventorySettings']['findFirstOrThrow']>>;

/** The business's inventory settings, created with defaults the first time they are needed. */
export async function loadInventorySettings(tx: Tx, businessId: string): Promise<InventorySettingsRow> {
  const found = await tx.inventorySettings.findUnique({ where: { businessId } });
  if (found) return found;
  await tx.inventorySettings.createMany({ data: [{ businessId }], skipDuplicates: true });
  return tx.inventorySettings.findUniqueOrThrow({ where: { businessId } });
}

export type InvNumberKind = 'purchase_order' | 'goods_receipt' | 'stock_transfer' | 'supplier_return';
const PREFIX = { purchase_order: 'poPrefix', goods_receipt: 'receiptPrefix', stock_transfer: 'transferPrefix', supplier_return: 'supplierReturnPrefix' } as const;

/**
 * Next number for an inventory document, e.g. PO-000123, or PO-CPT-000123 when the location has a document code. Allocated on
 * the server inside the caller's transaction: two requests can never get the same number and a rollback gives it back.
 */
export async function nextInventoryNumber(tx: Tx, businessId: string, kind: InvNumberKind, settings: InventorySettingsRow, locationId?: string | null): Promise<string> {
  const base = settings[PREFIX[kind]];
  let code: string | null = null;
  if (locationId && kind !== 'supplier_return') code = (await tx.location.findFirst({ where: { id: locationId, businessId }, select: { docCode: true } }))?.docCode ?? null;
  return nextNumber(tx, businessId, code ? `${kind}:${code}` : kind, code ? `${base}-${code}` : base, settings.numberPadding);
}

// ───────── Locations ─────────

export interface StockLocation { id: string; name: string; isDefault: boolean }

/** Active locations this member may use for stock. Everyone sees at least the locations they have been given. */
export async function accessibleLocations(tx: Tx, ctx: BusinessContext): Promise<StockLocation[]> {
  const scope = await visibleLocationIds(tx, ctx);
  return tx.location.findMany({
    where: { businessId: ctx.business.id, status: 'ACTIVE', ...(scope ? { id: { in: scope } } : {}) },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, isDefault: true },
  });
}

/** The location must exist in THIS business, be active, and be one this member may use. Anything else reads as "not available". */
export async function assertStockLocation(tx: Tx, ctx: BusinessContext, locationId: string): Promise<void> {
  const ok = (await accessibleLocations(tx, ctx)).some((l) => l.id === locationId);
  if (!ok) throw Errors.validation({ locationId: 'Choose a location you have access to.' });
}

/** The location to use when the caller did not name one: the business's main location if they may use it, else their first. */
export async function resolveLocation(tx: Tx, ctx: BusinessContext, locationId?: string | null): Promise<string> {
  if (locationId) {
    await assertStockLocation(tx, ctx, locationId);
    return locationId;
  }
  const mine = await accessibleLocations(tx, ctx);
  const first = mine[0];
  if (!first) throw Errors.validation({ locationId: 'You do not have access to any location.' });
  return first.id;
}

/** The ids of the locations to count: the caller's own scope, narrowed by one location if they picked it (which must be in scope). */
export async function scopedLocationIds(tx: Tx, ctx: BusinessContext, only?: string | null): Promise<string[]> {
  const mine = (await accessibleLocations(tx, ctx)).map((l) => l.id);
  if (only) {
    if (!mine.includes(only)) throw Errors.validation({ locationId: 'Choose a location you have access to.' });
    return [only];
  }
  return mine;
}

// ───────── Costs ─────────

export const canSeeCosts = (ctx: Pick<BusinessContext, 'permissions'>) => can(ctx, 'inventory.view_costs');

/** Remove cost fields from a row unless the caller may see costs. */
export function hideCosts<T extends Record<string, unknown>>(ctx: Pick<BusinessContext, 'permissions'>, row: T, keys: string[]): T {
  if (canSeeCosts(ctx)) return row;
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) if (k in out) out[k] = null;
  return out as T;
}

// ───────── Stock errors ─────────

/** The database says "not enough stock" with a marker; turn that (and the other stock guards) into a clear, safe message. */
export function stockErrorFrom(err: unknown): never {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    parts.push(String((e as { message?: unknown }).message ?? e));
    e = (e as { cause?: unknown }).cause;
  }
  const text = parts.join(' ');
  if (text.includes('TFME_STOCK_INSUFFICIENT')) throw Errors.conflict('There is not enough stock available. Someone else may have just used it.');
  if (text.includes('TFME_STOCK:')) throw Errors.conflict('That stock change is not allowed: it would release more than is reserved.');
  if (text.includes('stock_movements_idem_uq')) throw Errors.conflict('That stock change was already recorded.');
  throw err;
}

export async function guardStock<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return stockErrorFrom(err);
  }
}

export interface Actor {
  businessId: string;
  userId: string | null;
  meta?: RequestMeta;
}
export const actorOf = (ctx: BusinessContext): Actor => ({ businessId: ctx.business.id, userId: ctx.user.id, meta: ctx.meta });

/** Take the business-wide lock for part identifiers (SKU, part number, barcode) so two requests cannot both claim the same one. */
export async function lockPartIdentifiers(tx: Tx, businessId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`part-identifiers:${businessId}`}, 0))`;
}

export const trimOrNull = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

/** Lock one row of an inventory table for the rest of the transaction (two people changing it are applied one after the other). */
export async function lockInventoryRow(tx: Tx, table: 'purchase_orders' | 'stock_transfers' | 'goods_receipts', businessId: string, id: string): Promise<void> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM ${table} WHERE id = $1::uuid AND business_id = $2::uuid FOR UPDATE`, id, businessId);
  if (rows.length === 0) throw Errors.notFound();
}
