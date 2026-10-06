/**
 * Money & quantity arithmetic.
 *
 * Rules:
 *  - Money is an integer count of minor units (cents). Never a float.
 *  - Quantities are integer thousandths ("milli-units") so 1.5 hours = 1500.
 *  - Rates (VAT, discounts) are integer basis points (15% = 1500).
 *  - Intermediate products use BigInt so nothing overflows or loses precision.
 *  - Rounding is "half away from zero", applied once per documented step, so
 *    every calculation is deterministic and reproducible.
 */

export type Cents = number;

export class MoneyError extends Error {}

const BPS = 10_000n;
const MILLI = 1_000n;

function assertSafeInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`${what} must be a safe integer, got ${n}`);
}

/** Integer division of BigInts, rounding half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (2n * d); // round half up on magnitudes
  return negative ? -q : q;
}

function toNumber(b: bigint): number {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new MoneyError('Amount out of range');
  return n;
}

/** Parse "123", "123.4", "123.45" into cents. Rejects >2 decimals and junk. */
export function parseDecimalToCents(input: string): Cents {
  const m = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new MoneyError(`Invalid amount: "${input}"`);
  const [, sign, whole, frac = ''] = m;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return sign ? -cents : cents;
}

/** Parse "1", "1.5", "0.25" into milli-units (max 3 decimals). */
export function parseQuantityToMilli(input: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (!m) throw new MoneyError(`Invalid quantity: "${input}"`);
  const [, whole, frac = ''] = m;
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}

/** Cents -> "1234.50" (plain decimal string, no symbol). */
export function centsToDecimal(cents: Cents): string {
  assertSafeInt(cents, 'cents');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Display formatting, e.g. "R 1 234,50" for en-ZA / ZAR. Display only. */
export function formatMoney(cents: Cents, currency = 'ZAR', locale = 'en-ZA'): string {
  assertSafeInt(cents, 'cents');
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** quantity (milli) x unit price (cents) -> cents. */
export function lineAmount(qtyMilli: number, unitPriceCents: Cents): Cents {
  assertSafeInt(qtyMilli, 'quantity');
  assertSafeInt(unitPriceCents, 'unit price');
  return toNumber(divRound(BigInt(qtyMilli) * BigInt(unitPriceCents), MILLI));
}

/** Apply a discount in basis points to an amount. Returns the discount (>= 0). */
export function discountAmount(amountCents: Cents, discountBps: number): Cents {
  assertSafeInt(amountCents, 'amount');
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000)
    throw new MoneyError('Discount must be between 0 and 10000 bps');
  return toNumber(divRound(BigInt(amountCents) * BigInt(discountBps), BPS));
}

/** VAT to add on top of a VAT-exclusive amount. */
export function vatOnExclusive(netCents: Cents, vatRateBps: number): Cents {
  assertSafeInt(netCents, 'net');
  assertRate(vatRateBps);
  return toNumber(divRound(BigInt(netCents) * BigInt(vatRateBps), BPS));
}

/** VAT contained in a VAT-inclusive amount. */
export function vatFromInclusive(grossCents: Cents, vatRateBps: number): Cents {
  assertSafeInt(grossCents, 'gross');
  assertRate(vatRateBps);
  const net = divRound(BigInt(grossCents) * BPS, BPS + BigInt(vatRateBps));
  return toNumber(BigInt(grossCents) - net);
}

function assertRate(bps: number) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new MoneyError('Invalid rate (bps)');
}

export interface DocLineInput {
  qtyMilli: number;
  unitPriceCents: Cents;
  discountBps?: number;
}

export interface DocTotals {
  /** Sum of line amounts after discounts, VAT-exclusive. */
  subtotalCents: Cents;
  /** Sum of discounts applied across lines. */
  discountCents: Cents;
  vatCents: Cents;
  totalCents: Cents;
}

/**
 * Totals for a quote/invoice. Each line is rounded once (qty x price, then
 * discount); VAT is calculated once on the document subtotal, which is how
 * South African tax invoices are normally totalled.
 *
 * pricesIncludeVat: line prices already contain VAT; the subtotal is derived
 * by extracting VAT from the gross so that total == sum of gross lines.
 * Not VAT-registered (vatRateBps 0 or vatRegistered false) => no VAT.
 */
export function computeDocumentTotals(
  lines: DocLineInput[],
  opts: { vatRegistered: boolean; vatRateBps: number; pricesIncludeVat?: boolean },
): DocTotals {
  let gross = 0;
  let discounts = 0;
  for (const l of lines) {
    const base = lineAmount(l.qtyMilli, l.unitPriceCents);
    const disc = discountAmount(base, l.discountBps ?? 0);
    gross += base - disc;
    discounts += disc;
    assertSafeInt(gross, 'document total');
  }
  const rate = opts.vatRegistered ? opts.vatRateBps : 0;
  if (opts.pricesIncludeVat && rate > 0) {
    const vat = vatFromInclusive(gross, rate);
    return { subtotalCents: gross - vat, discountCents: discounts, vatCents: vat, totalCents: gross };
  }
  const vat = rate > 0 ? vatOnExclusive(gross, rate) : 0;
  return { subtotalCents: gross, discountCents: discounts, vatCents: vat, totalCents: gross + vat };
}

/**
 * Split an amount across parts in proportion to weights without losing a cent
 * (largest-remainder method). allocate(100, [1,1,1]) -> [34, 33, 33].
 */
export function allocate(totalCents: Cents, weights: number[]): Cents[] {
  assertSafeInt(totalCents, 'total');
  if (weights.length === 0 || weights.some((w) => !Number.isInteger(w) || w < 0))
    throw new MoneyError('Weights must be non-negative integers');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) throw new MoneyError('Weights must not all be zero');
  const sign = totalCents < 0 ? -1 : 1;
  const abs = BigInt(Math.abs(totalCents));
  const shares = weights.map((w) => (abs * BigInt(w)) / BigInt(sum));
  let remainder = abs - shares.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, frac: (abs * BigInt(w)) % BigInt(sum) }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (remainder === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    remainder -= 1n;
  }
  return shares.map((s) => sign * toNumber(s));
}

/** Labour: minutes at an hourly rate, rounded half away from zero to a whole cent (e.g. 20 min at R450/h = R150.00). */
export function minutesAmount(minutes: number, ratePerHourCents: Cents): Cents {
  assertSafeInt(minutes, 'minutes');
  assertSafeInt(ratePerHourCents, 'rate');
  return toNumber(divRound(BigInt(minutes) * BigInt(ratePerHourCents), 60n));
}
