import { MoneyError, allocate, discountAmount, lineAmount, vatFromInclusive, vatOnExclusive } from '@/lib/money';
import { Errors } from '@/lib/errors';

/**
 * The financial rules, as pure functions with no database access: line and document totals, VAT, discounts,
 * invoice balance and status, ageing, and how payments, credits, credit notes and refunds are split.
 * Everything that moves money goes through here, and the database re-checks the identities (see migration 0006).
 *
 * Conventions: money = integer cents, quantity = integer thousandths, rates and percentage discounts = basis points.
 * A line's amounts are always stored VAT-exclusive (`base`, `discount`, `taxable`) with `vat` and `total` beside them,
 * so  taxable = base - discount  and  total = taxable + vat  hold exactly for every line and therefore for every document.
 */

/** Largest amount one document or payment may carry (the database stores 32-bit cents). */
export const MAX_AMOUNT_CENTS = 2_000_000_000;

export type DiscountKind = 'NONE' | 'PERCENT' | 'FIXED';
export type Treatment = 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';

export interface LineCalcInput {
  quantityMilli: number;
  unitPriceCents: number;
  discountType: DiscountKind;
  /** PERCENT: basis points (0-10000). FIXED: cents. */
  discountValue: number;
  taxTreatment: Treatment;
}

export interface TaxContext {
  vatRegistered: boolean;
  vatRateBps: number;
  /** true = the prices typed on the document already include VAT. */
  pricesIncludeVat: boolean;
}

export interface DocDiscount {
  type: DiscountKind;
  value: number;
}

export interface LineCalc {
  vatRateBps: number;
  /** quantity x price, VAT-exclusive, before any discount. */
  baseCents: number;
  /** Line discount plus this line's share of the document discount, VAT-exclusive. */
  discountCents: number;
  taxableCents: number;
  vatCents: number;
  totalCents: number;
}

export interface DocCalc {
  lines: LineCalc[];
  subtotalCents: number;
  discountCents: number;
  taxableCents: number;
  vatCents: number;
  totalCents: number;
}

const bad = (field: string, message: string) => Errors.validation({ [field]: message });

/** The VAT rate that applies to one line (0 for a non-VAT business and for zero-rated / exempt lines). */
export const lineVatRate = (tax: TaxContext, t: Treatment) => (tax.vatRegistered && t === 'STANDARD' ? tax.vatRateBps : 0);

function checkLine(l: LineCalcInput, n: number): void {
  const f = (k: string) => `lines.${n}.${k}`;
  if (!Number.isSafeInteger(l.quantityMilli) || l.quantityMilli <= 0) throw bad(f('quantity'), 'Quantity must be more than zero.');
  if (l.quantityMilli > 1_000_000_000) throw bad(f('quantity'), 'Quantity is too large.');
  if (!Number.isSafeInteger(l.unitPriceCents) || l.unitPriceCents < 0) throw bad(f('unitPrice'), 'Price cannot be negative.');
  if (!Number.isSafeInteger(l.discountValue) || l.discountValue < 0) throw bad(f('discount'), 'Discount cannot be negative.');
  if (l.discountType === 'PERCENT' && l.discountValue > 10_000) throw bad(f('discount'), 'A percentage discount cannot be more than 100%.');
  if (l.discountType === 'NONE' && l.discountValue !== 0) throw bad(f('discount'), 'Choose a discount type or clear the value.');
}

/**
 * Totals for a document. Order of operations (each step rounds once, half away from zero):
 *   1. line amount = quantity x unit price;  2. line discount (percent or fixed);
 *   3. document discount (percent or fixed) spread over the lines in proportion to what they have left, without losing a cent;
 *   4. VAT per line on what remains: added to it (prices exclude VAT) or extracted from it (prices include VAT).
 * Discounts can never push a line or the document below zero. Nothing here trusts a total supplied by a client.
 */
export function calculateDocument(lines: LineCalcInput[], tax: TaxContext, discount: DocDiscount = { type: 'NONE', value: 0 }): DocCalc {
  if (!Number.isInteger(tax.vatRateBps) || tax.vatRateBps < 0 || tax.vatRateBps > 10_000) throw bad('vatRate', 'The VAT rate must be between 0% and 100%.');
  try {
    const entered: number[] = [];
    const afterLine: number[] = [];
    lines.forEach((l, i) => {
      checkLine(l, i);
      const amount = lineAmount(l.quantityMilli, l.unitPriceCents);
      let d = 0;
      if (l.discountType === 'PERCENT') d = discountAmount(amount, l.discountValue);
      else if (l.discountType === 'FIXED') {
        if (l.discountValue > amount) throw bad(`lines.${i}.discount`, 'The discount is more than the line amount.');
        d = l.discountValue;
      }
      entered.push(amount);
      afterLine.push(amount - d);
    });

    const remaining = afterLine.reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(discount.value) || discount.value < 0) throw bad('discount', 'Discount cannot be negative.');
    if (discount.type === 'NONE' && discount.value !== 0) throw bad('discount', 'Choose a discount type or clear the value.');
    if (discount.type === 'PERCENT' && discount.value > 10_000) throw bad('discount', 'A percentage discount cannot be more than 100%.');
    let docDiscount = 0;
    if (discount.type === 'PERCENT') docDiscount = discountAmount(remaining, discount.value);
    else if (discount.type === 'FIXED') {
      if (discount.value > remaining) throw bad('discount', 'The discount is more than the total of the lines.');
      docDiscount = discount.value;
    }
    const shares = docDiscount > 0 && remaining > 0 ? allocate(docDiscount, afterLine) : afterLine.map(() => 0);

    const out: LineCalc[] = lines.map((l, i) => {
      const rate = lineVatRate(tax, l.taxTreatment);
      const left = afterLine[i]! - shares[i]!; // what the line is worth after all discounts, in the price terms typed
      if (left < 0) throw bad(`lines.${i}.discount`, 'Discounts cannot take a line below zero.');
      if (tax.pricesIncludeVat) {
        const vat = rate > 0 ? vatFromInclusive(left, rate) : 0;
        const taxable = left - vat;
        const baseNet = entered[i]! - (rate > 0 ? vatFromInclusive(entered[i]!, rate) : 0);
        return { vatRateBps: rate, baseCents: baseNet, discountCents: baseNet - taxable, taxableCents: taxable, vatCents: vat, totalCents: left };
      }
      const vat = rate > 0 ? vatOnExclusive(left, rate) : 0;
      return { vatRateBps: rate, baseCents: entered[i]!, discountCents: entered[i]! - left, taxableCents: left, vatCents: vat, totalCents: left + vat };
    });

    const sum = (k: keyof LineCalc) => out.reduce((a, l) => a + l[k], 0);
    const doc: DocCalc = {
      lines: out,
      subtotalCents: sum('baseCents'),
      discountCents: sum('discountCents'),
      taxableCents: sum('taxableCents'),
      vatCents: sum('vatCents'),
      totalCents: sum('totalCents'),
    };
    if (doc.totalCents > MAX_AMOUNT_CENTS || doc.subtotalCents > MAX_AMOUNT_CENTS) throw bad('lines', 'This document is too large. Split it into more than one.');
    return doc;
  } catch (err) {
    if (err instanceof MoneyError) throw bad('lines', err.message);
    throw err;
  }
}

// ───────── Invoice balance, status and ageing ─────────

export interface BalanceParts {
  totalCents: number;
  paidCents: number;
  creditAppliedCents: number;
  creditNotedCents: number;
  writtenOffCents: number;
}

export const outstandingOf = (b: BalanceParts) => b.totalCents - b.paidCents - b.creditAppliedCents - b.creditNotedCents - b.writtenOffCents;

export interface StatusFacts extends BalanceParts {
  finalised: boolean;
  cancelled: boolean;
  writtenOff: boolean;
  sent: boolean;
  viewed: boolean;
  /** YYYY-MM-DD in the business's time zone, or null for a draft. */
  dueDate: string | null;
}

export type InvoiceStatusValue = 'DRAFT' | 'ISSUED' | 'SENT' | 'VIEWED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'WRITTEN_OFF';
export type InvoicePaymentStatusValue = 'DRAFT' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED' | 'WRITTEN_OFF';

/**
 * The invoice's status and payment status, derived from facts only. The browser never decides either.
 * "Paid" is only reached when nothing is left to collect, so a part payment can never mark an invoice Paid.
 */
export function deriveInvoiceState(f: StatusFacts, today: string): { status: InvoiceStatusValue; paymentStatus: InvoicePaymentStatusValue; outstandingCents: number } {
  const outstanding = outstandingOf(f);
  if (f.cancelled) return { status: 'CANCELLED', paymentStatus: 'CANCELLED', outstandingCents: outstanding };
  if (!f.finalised) return { status: 'DRAFT', paymentStatus: 'DRAFT', outstandingCents: outstanding };
  if (outstanding === 0) {
    return f.writtenOff && f.writtenOffCents > 0
      ? { status: 'WRITTEN_OFF', paymentStatus: 'WRITTEN_OFF', outstandingCents: 0 }
      : { status: 'PAID', paymentStatus: 'PAID', outstandingCents: 0 };
  }
  const settled = f.paidCents + f.creditAppliedCents;
  const paymentStatus: InvoicePaymentStatusValue = settled > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
  if (f.dueDate && f.dueDate < today) return { status: 'OVERDUE', paymentStatus, outstandingCents: outstanding };
  if (settled > 0) return { status: 'PARTIALLY_PAID', paymentStatus, outstandingCents: outstanding };
  return { status: f.viewed ? 'VIEWED' : f.sent ? 'SENT' : 'ISSUED', paymentStatus, outstandingCents: outstanding };
}

export type AgeBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';
export const AGE_BUCKETS: AgeBucket[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
export const AGE_LABEL: Record<AgeBucket, string> = { current: 'Current', d1_30: '1–30 days overdue', d31_60: '31–60 days overdue', d61_90: '61–90 days overdue', d90_plus: '90+ days overdue' };

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
export const daysBetween = (fromIso: string, toIso: string) => dayNumber(toIso) - dayNumber(fromIso);

/** Which ageing bucket an unpaid balance falls in. Not yet due (or due today) is Current. */
export function ageBucket(dueDate: string, today: string): AgeBucket {
  const late = daysBetween(dueDate, today);
  if (late <= 0) return 'current';
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'd90_plus';
}

// ───────── Splitting money ─────────

/** A payment against an invoice: what reduces the invoice, and what is left over to become customer credit. */
export function splitPayment(amountCents: number, outstandingCents: number): { applied: number; credited: number } {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw bad('amount', 'Enter an amount greater than zero.');
  if (amountCents > MAX_AMOUNT_CENTS) throw bad('amount', 'That amount is too large.');
  const applied = Math.min(amountCents, Math.max(0, outstandingCents));
  return { applied, credited: amountCents - applied };
}

export interface RefundablePayment {
  amountCents: number;
  appliedCents: number;
  creditedCents: number;
  refundedAppliedCents: number;
  refundedCreditCents: number;
}

export const refundableOf = (p: RefundablePayment) => p.amountCents - p.refundedAppliedCents - p.refundedCreditCents;

/**
 * Split a refund between the credit the payment created and the invoice it settled. Credit comes back first
 * (it was never applied to anything) but only as much as the customer still has; the rest reopens the invoice.
 * Refusing anything above what can truly be returned is what makes a double refund impossible.
 */
export function splitRefund(amountCents: number, p: RefundablePayment, customerCreditCents: number): { fromCredit: number; fromInvoice: number } {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw bad('amount', 'Enter an amount greater than zero.');
  const refundable = refundableOf(p);
  if (amountCents > refundable) throw Errors.conflict(`Only ${(refundable / 100).toFixed(2)} of this payment can still be refunded.`, { maxCents: refundable });
  const creditLeft = p.creditedCents - p.refundedCreditCents;
  const invoiceLeft = p.appliedCents - p.refundedAppliedCents;
  const fromCredit = Math.min(amountCents, creditLeft, Math.max(0, customerCreditCents));
  const fromInvoice = amountCents - fromCredit;
  if (fromInvoice > invoiceLeft) {
    const max = invoiceLeft + Math.min(creditLeft, Math.max(0, customerCreditCents));
    throw Errors.conflict(`Part of this payment was kept as customer credit and has since been used, so at most ${(max / 100).toFixed(2)} can be refunded.`, { maxCents: max });
  }
  return { fromCredit, fromInvoice };
}

/** How much of a credit note reduces the invoice and how much becomes customer credit. */
export function splitCreditNote(totalCents: number, outstandingCents: number): { applied: number; credited: number } {
  const applied = Math.min(totalCents, Math.max(0, outstandingCents));
  return { applied, credited: totalCents - applied };
}

/** Payment status after refunds. */
export function paymentStatusAfterRefund(p: RefundablePayment): 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' {
  const refunded = p.refundedAppliedCents + p.refundedCreditCents;
  return refunded === 0 ? 'COMPLETED' : refunded >= p.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}

/** Payment state machine. A payment only ever moves forward; money-moving states are reached by code paths, not by a status field a user sets. */
export const PAYMENT_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  // A provider can still confirm a payment we had marked failed or cancelled (the customer's money really moved); only a verified webhook does this.
  FAILED: ['COMPLETED'],
  CANCELLED: ['COMPLETED'],
  REFUNDED: [],
};

export const canMovePayment = (from: string, to: string) => (PAYMENT_TRANSITIONS[from] ?? []).includes(to);

/** Quote state machine: who may move where is checked separately (permissions); this says what is possible at all. */
export const QUOTE_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED', 'APPROVED'],
  SENT: ['VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED', 'DRAFT', 'CANCELLED'],
  VIEWED: ['APPROVED', 'DECLINED', 'EXPIRED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['CONVERTED', 'CANCELLED'],
  DECLINED: ['DRAFT', 'CANCELLED'],
  EXPIRED: ['DRAFT', 'CANCELLED'],
  CONVERTED: [],
  CANCELLED: [],
};

export const canMoveQuote = (from: string, to: string) => (QUOTE_TRANSITIONS[from] ?? []).includes(to);

/** Add days to a YYYY-MM-DD date. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
