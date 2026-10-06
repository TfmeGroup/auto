/**
 * The inventory rules as pure functions (no database), so they are easy to read and test. The database enforces the
 * same invariants independently (migration 0008): quantities change only through movements, and availability
 * (on hand minus reserved) never drops below zero unless the business has explicitly allowed negative stock.
 */

export type StockState = 'NORMAL' | 'LOW' | 'OUT';

/** What can be promised to a job right now. Never the raw on-hand figure. */
export const availableOf = (onHand: number, reserved: number) => onHand - reserved;

/**
 * Out of stock = nothing available. Low = something is available but at or below the level the business wants to hold
 * (the larger of the minimum stock and the reorder level, when either is set).
 */
export function stockState(available: number, minStock: number, reorderLevel: number | null | undefined): StockState {
  if (available <= 0) return 'OUT';
  const threshold = Math.max(minStock, reorderLevel ?? 0);
  return threshold > 0 && available <= threshold ? 'LOW' : 'NORMAL';
}

export const STOCK_STATE_LABEL: Record<StockState, string> = { NORMAL: 'In stock', LOW: 'Low stock', OUT: 'Out of stock' };

/** How many to order to get back to a sensible level: the reorder quantity if set, else enough to clear the minimum. */
export function suggestedReorder(available: number, minStock: number, reorderLevel: number | null | undefined, reorderQuantity: number | null | undefined): number {
  if (reorderQuantity && reorderQuantity > 0) return reorderQuantity;
  const target = Math.max(minStock, reorderLevel ?? 0);
  return Math.max(0, target - available);
}

/**
 * New cost per unit after receiving `qty` at `unitCost`. LAST_COST simply takes the price just paid; AVERAGE_COST
 * blends it with what is already on hand (rounded half up to a whole cent). With nothing on hand, or no known cost,
 * the average is the new price.
 */
export function costAfterReceipt(method: 'LAST_COST' | 'AVERAGE_COST', current: { onHand: number; costCents: number | null }, receivedQty: number, unitCostCents: number): number {
  if (method === 'LAST_COST' || current.costCents === null || current.onHand <= 0) return unitCostCents;
  const total = current.onHand * current.costCents + receivedQty * unitCostCents;
  return Math.floor((2 * total + (current.onHand + receivedQty)) / (2 * (current.onHand + receivedQty)));
}

/** Gross margin in cents and as basis points of revenue (null when there is no revenue to divide by). */
export function margin(revenueCents: number, costCents: number): { marginCents: number; marginBps: number | null } {
  const marginCents = revenueCents - costCents;
  return { marginCents, marginBps: revenueCents > 0 ? Math.round((marginCents * 10_000) / revenueCents) : null };
}

/** Purchase-order status after a delivery: Received only when nothing is still outstanding. */
export function orderStatusAfterReceipt(lines: { quantityOrdered: number; quantityReceived: number; quantityCancelled: number }[]): 'PARTIALLY_RECEIVED' | 'RECEIVED' {
  const outstanding = lines.some((l) => l.quantityOrdered - l.quantityReceived - l.quantityCancelled > 0);
  return outstanding ? 'PARTIALLY_RECEIVED' : 'RECEIVED';
}

export const outstandingOf = (l: { quantityOrdered: number; quantityReceived: number; quantityCancelled: number }) => l.quantityOrdered - l.quantityReceived - l.quantityCancelled;

// ───────── Vehicle compatibility: plain, deterministic matching ─────────

export interface CompatRule {
  make?: string | null;
  model?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  variant?: string | null;
  engine?: string | null;
  engineSizeCc?: number | null;
  fuelType?: string | null;
  transmission?: string | null;
}
export interface VehicleFacts {
  make?: string | null;
  model?: string | null;
  year?: number | null;
  variant?: string | null;
  engine?: string | null;
  engineSizeCc?: number | null;
  fuelType?: string | null;
  transmission?: string | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * A rule matches a vehicle when every attribute the rule names agrees with the vehicle. An attribute the rule leaves blank
 * does not restrict anything. An attribute the rule names but the vehicle lacks is NOT a match (we never guess). This only
 * helps staff find parts; it is not a fitment guarantee and never overrides a technician's judgment.
 */
export function ruleMatchesVehicle(rule: CompatRule, v: VehicleFacts): boolean {
  if (rule.make && !same(rule.make, v.make)) return false;
  if (rule.model && !same(rule.model, v.model)) return false;
  if (rule.variant && !same(rule.variant, v.variant)) return false;
  if (rule.engine && !same(rule.engine, v.engine)) return false;
  if (rule.engineSizeCc != null && rule.engineSizeCc !== v.engineSizeCc) return false;
  if (rule.fuelType && !same(rule.fuelType, v.fuelType)) return false;
  if (rule.transmission && !same(rule.transmission, v.transmission)) return false;
  if (rule.yearFrom != null && (v.year == null || v.year < rule.yearFrom)) return false;
  if (rule.yearTo != null && (v.year == null || v.year > rule.yearTo)) return false;
  return true;
}

export const partFitsVehicle = (rules: CompatRule[], v: VehicleFacts) => rules.some((r) => ruleMatchesVehicle(r, v));

// ───────── Time ─────────

/** Whole minutes between two instants, rounded to the nearest minute. */
export const minutesBetween = (start: Date, end: Date) => Math.round((end.getTime() - start.getTime()) / 60_000);

export const MAX_ENTRY_MINUTES = 24 * 60;
