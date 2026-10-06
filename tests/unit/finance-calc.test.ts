import { describe, expect, it } from 'vitest';
import {
  AGE_BUCKETS, MAX_AMOUNT_CENTS, addDaysIso, ageBucket, calculateDocument, canMovePayment, canMoveQuote, daysBetween, deriveInvoiceState, outstandingOf, paymentStatusAfterRefund,
  refundableOf, splitCreditNote, splitPayment, splitRefund, type LineCalcInput, type StatusFacts, type TaxContext,
} from '@/server/finance/calc';
import { dueReminder } from '@/server/finance/scheduled';
import { AppError } from '@/lib/errors';

const VAT: TaxContext = { vatRegistered: true, vatRateBps: 1500, pricesIncludeVat: false };
const VAT_INC: TaxContext = { vatRegistered: true, vatRateBps: 1500, pricesIncludeVat: true };
const NO_VAT: TaxContext = { vatRegistered: false, vatRateBps: 1500, pricesIncludeVat: false };

const line = (qtyMilli: number, unitPriceCents: number, over: Partial<LineCalcInput> = {}): LineCalcInput => ({
  quantityMilli: qtyMilli, unitPriceCents, discountType: 'NONE', discountValue: 0, taxTreatment: 'STANDARD', ...over,
});

const bad = (fn: () => unknown) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(AppError); return (e as AppError); }
  throw new Error('expected a validation error');
};

describe('document totals', () => {
  it('prices exclude VAT: VAT is added on top, per line', () => {
    const d = calculateDocument([line(2000, 50_000), line(1500, 45_000)], VAT);
    // 2 x R500 = R1000; 1.5 x R450 = R675
    expect(d.subtotalCents).toBe(167_500);
    expect(d.discountCents).toBe(0);
    expect(d.vatCents).toBe(25_125);
    expect(d.totalCents).toBe(192_625);
    expect(d.lines.map((l) => l.vatCents)).toEqual([15_000, 10_125]);
  });

  it('prices include VAT: VAT is extracted, the total equals what was typed', () => {
    const d = calculateDocument([line(1000, 115_000)], VAT_INC);
    expect(d.totalCents).toBe(115_000);
    expect(d.vatCents).toBe(15_000);
    expect(d.taxableCents).toBe(100_000);
    expect(d.subtotalCents).toBe(100_000);
  });

  it('a business that is not VAT registered never charges VAT, whatever the rate setting says', () => {
    const d = calculateDocument([line(1000, 100_000)], NO_VAT);
    expect(d.vatCents).toBe(0);
    expect(d.totalCents).toBe(100_000);
    expect(d.lines[0]!.vatRateBps).toBe(0);
  });

  it('zero-rated and exempt lines carry no VAT even for a VAT-registered business', () => {
    const d = calculateDocument([line(1000, 100_000), line(1000, 100_000, { taxTreatment: 'ZERO_RATED' }), line(1000, 100_000, { taxTreatment: 'EXEMPT' })], VAT);
    expect(d.vatCents).toBe(15_000);
    expect(d.totalCents).toBe(315_000);
  });

  it('uses the configured rate, not a hard-coded 15%', () => {
    const d = calculateDocument([line(1000, 100_000)], { vatRegistered: true, vatRateBps: 1000, pricesIncludeVat: false });
    expect(d.vatCents).toBe(10_000);
    const e = calculateDocument([line(1000, 100_000)], { vatRegistered: true, vatRateBps: 2000, pricesIncludeVat: false });
    expect(e.vatCents).toBe(20_000);
  });

  it('line discounts: percentage and fixed', () => {
    const p = calculateDocument([line(1000, 100_000, { discountType: 'PERCENT', discountValue: 1000 })], VAT); // 10%
    expect(p.discountCents).toBe(10_000);
    expect(p.taxableCents).toBe(90_000);
    expect(p.vatCents).toBe(13_500);
    expect(p.totalCents).toBe(103_500);
    const f = calculateDocument([line(1000, 100_000, { discountType: 'FIXED', discountValue: 25_000 })], VAT);
    expect(f.discountCents).toBe(25_000);
    expect(f.totalCents).toBe(86_250);
  });

  it('a document discount is spread over the lines without losing a cent', () => {
    const lines = [line(1000, 10_000), line(1000, 10_000), line(1000, 10_000)];
    const d = calculateDocument(lines, NO_VAT, { type: 'FIXED', value: 100 });
    expect(d.discountCents).toBe(100);
    expect(d.lines.map((l) => l.discountCents).sort()).toEqual([33, 33, 34]);
    expect(d.totalCents).toBe(29_900);
  });

  it('a percentage document discount applies after line discounts', () => {
    const d = calculateDocument([line(1000, 100_000, { discountType: 'PERCENT', discountValue: 1000 })], NO_VAT, { type: 'PERCENT', value: 1000 });
    expect(d.discountCents).toBe(19_000); // 10% off R1000, then 10% off R900
    expect(d.totalCents).toBe(81_000);
  });

  it('discounts with VAT-inclusive prices stay consistent', () => {
    const d = calculateDocument([line(1000, 115_000)], VAT_INC, { type: 'FIXED', value: 11_500 });
    expect(d.totalCents).toBe(103_500);
    expect(d.vatCents).toBe(13_500);
    expect(d.taxableCents).toBe(90_000);
    expect(d.subtotalCents - d.discountCents).toBe(d.taxableCents);
  });

  it('refuses discounts that would make anything negative', () => {
    expect(bad(() => calculateDocument([line(1000, 10_000)], VAT, { type: 'FIXED', value: 10_001 })).details).toHaveProperty('discount');
    expect(bad(() => calculateDocument([line(1000, 10_000, { discountType: 'FIXED', discountValue: 10_001 })], VAT)).details).toHaveProperty('lines.0.discount');
    expect(bad(() => calculateDocument([line(1000, 10_000, { discountType: 'PERCENT', discountValue: 10_001 })], VAT)).details).toHaveProperty('lines.0.discount');
    expect(bad(() => calculateDocument([line(1000, 10_000)], VAT, { type: 'PERCENT', value: 10_001 })).details).toHaveProperty('discount');
  });

  it('refuses impossible quantities, prices and rates', () => {
    expect(bad(() => calculateDocument([line(0, 100)], VAT))).toBeTruthy();
    expect(bad(() => calculateDocument([line(-1000, 100)], VAT))).toBeTruthy();
    expect(bad(() => calculateDocument([line(1000, -1)], VAT))).toBeTruthy();
    expect(bad(() => calculateDocument([line(1.5, 100)], VAT))).toBeTruthy();
    expect(bad(() => calculateDocument([line(1000, 100)], { ...VAT, vatRateBps: 10_001 }))).toBeTruthy();
    expect(bad(() => calculateDocument([line(1000, 100, { discountType: 'NONE', discountValue: 5 })], VAT))).toBeTruthy();
  });

  it('refuses a document too large to store', () => {
    expect(bad(() => calculateDocument([line(1_000_000, 2_000_000_000)], NO_VAT))).toBeTruthy();
    expect(MAX_AMOUNT_CENTS).toBe(2_000_000_000);
  });

  it('fractional quantities round once, half away from zero', () => {
    const d = calculateDocument([line(333, 100)], NO_VAT); // 0.333 x R1.00 = 33.3c -> 33c
    expect(d.totalCents).toBe(33);
    const e = calculateDocument([line(1500, 1)], NO_VAT); // 1.5c -> 2c
    expect(e.totalCents).toBe(2);
  });

  it('every line and every document satisfy the identities the database also enforces (400 random documents)', () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      const tax: TaxContext = [VAT, VAT_INC, NO_VAT][rnd(3)]!;
      const lines = Array.from({ length: 1 + rnd(6) }, () => {
        const dt = (['NONE', 'PERCENT', 'FIXED'] as const)[rnd(3)]!;
        const q = 1 + rnd(20_000);
        const p = rnd(500_000);
        const base = Math.round((q * p) / 1000);
        return line(q, p, { discountType: dt, discountValue: dt === 'PERCENT' ? rnd(10_001) : dt === 'FIXED' ? rnd(base + 1) : 0, taxTreatment: (['STANDARD', 'STANDARD', 'ZERO_RATED', 'EXEMPT'] as const)[rnd(4)]! });
      });
      const docType = (['NONE', 'PERCENT', 'FIXED'] as const)[rnd(3)]!;
      const sumAfter = lines.reduce((a, l) => {
        const base = Math.round((l.quantityMilli * l.unitPriceCents) / 1000);
        const d = l.discountType === 'PERCENT' ? Math.round((base * l.discountValue) / 10_000) : l.discountType === 'FIXED' ? l.discountValue : 0;
        return a + base - d;
      }, 0);
      const doc = calculateDocument(lines, tax, { type: docType, value: docType === 'PERCENT' ? rnd(10_001) : docType === 'FIXED' ? rnd(sumAfter + 1) : 0 });
      for (const l of doc.lines) {
        expect(l.taxableCents).toBe(l.baseCents - l.discountCents);
        expect(l.totalCents).toBe(l.taxableCents + l.vatCents);
        expect(l.baseCents).toBeGreaterThanOrEqual(0);
        expect(l.discountCents).toBeGreaterThanOrEqual(0);
        expect(l.taxableCents).toBeGreaterThanOrEqual(0);
      }
      expect(doc.taxableCents).toBe(doc.subtotalCents - doc.discountCents);
      expect(doc.totalCents).toBe(doc.taxableCents + doc.vatCents);
      expect(doc.lines.reduce((a, l) => a + l.totalCents, 0)).toBe(doc.totalCents);
      if (!tax.vatRegistered) expect(doc.vatCents).toBe(0);
    }
  });
});

describe('invoice balance and status', () => {
  const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
    totalCents: 10_000, paidCents: 0, creditAppliedCents: 0, creditNotedCents: 0, writtenOffCents: 0, finalised: true, cancelled: false, writtenOff: false, sent: false, viewed: false, dueDate: '2030-01-31', ...over,
  });
  const today = '2030-01-15';

  it('outstanding = total less everything that settled it', () => {
    expect(outstandingOf({ totalCents: 10_000, paidCents: 3000, creditAppliedCents: 1000, creditNotedCents: 500, writtenOffCents: 0 })).toBe(5500);
  });

  it('the status lifecycle', () => {
    expect(deriveInvoiceState(facts({ finalised: false, dueDate: null }), today)).toMatchObject({ status: 'DRAFT', paymentStatus: 'DRAFT' });
    expect(deriveInvoiceState(facts(), today)).toMatchObject({ status: 'ISSUED', paymentStatus: 'UNPAID' });
    expect(deriveInvoiceState(facts({ sent: true }), today).status).toBe('SENT');
    expect(deriveInvoiceState(facts({ sent: true, viewed: true }), today).status).toBe('VIEWED');
    expect(deriveInvoiceState(facts({ paidCents: 3000 }), today)).toMatchObject({ status: 'PARTIALLY_PAID', paymentStatus: 'PARTIALLY_PAID', outstandingCents: 7000 });
    expect(deriveInvoiceState(facts({ paidCents: 10_000 }), today)).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', outstandingCents: 0 });
    expect(deriveInvoiceState(facts({ cancelled: true }), today)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'CANCELLED' });
    expect(deriveInvoiceState(facts({ writtenOff: true, writtenOffCents: 10_000 }), today)).toMatchObject({ status: 'WRITTEN_OFF', paymentStatus: 'WRITTEN_OFF', outstandingCents: 0 });
  });

  it('a part payment never makes an invoice Paid, a full one always does', () => {
    for (let paid = 0; paid < 10_000; paid += 997) expect(deriveInvoiceState(facts({ paidCents: paid }), today).status).not.toBe('PAID');
    expect(deriveInvoiceState(facts({ paidCents: 9_999 }), today).status).not.toBe('PAID');
    expect(deriveInvoiceState(facts({ paidCents: 6000, creditAppliedCents: 4000 }), today).status).toBe('PAID');
    expect(deriveInvoiceState(facts({ paidCents: 5000, creditNotedCents: 5000 }), today).status).toBe('PAID');
  });

  it('overdue only when something is still owed and the due date has passed', () => {
    expect(deriveInvoiceState(facts({ dueDate: '2030-01-14' }), today)).toMatchObject({ status: 'OVERDUE', paymentStatus: 'UNPAID' });
    expect(deriveInvoiceState(facts({ dueDate: '2030-01-14', paidCents: 100 }), today)).toMatchObject({ status: 'OVERDUE', paymentStatus: 'PARTIALLY_PAID' });
    expect(deriveInvoiceState(facts({ dueDate: '2030-01-15' }), today).status).toBe('ISSUED'); // due today is not overdue
    expect(deriveInvoiceState(facts({ dueDate: '2020-01-01', paidCents: 10_000 }), today).status).toBe('PAID');
    expect(deriveInvoiceState(facts({ dueDate: '2020-01-01', cancelled: true }), today).status).toBe('CANCELLED');
  });
});

describe('ageing', () => {
  it('buckets by days past due', () => {
    const t = '2030-04-01';
    expect(ageBucket('2030-04-10', t)).toBe('current');
    expect(ageBucket('2030-04-01', t)).toBe('current');
    expect(ageBucket('2030-03-31', t)).toBe('d1_30');
    expect(ageBucket('2030-03-02', t)).toBe('d1_30');
    expect(ageBucket('2030-03-01', t)).toBe('d31_60');
    expect(ageBucket('2030-01-31', t)).toBe('d31_60');
    expect(ageBucket('2030-01-30', t)).toBe('d61_90');
    expect(ageBucket('2030-01-01', t)).toBe('d61_90'); // exactly 90 days late is still 61-90
    expect(ageBucket('2029-12-31', t)).toBe('d90_plus');
    expect(AGE_BUCKETS).toHaveLength(5);
  });
  it('date helpers', () => {
    expect(daysBetween('2030-01-01', '2030-01-31')).toBe(30);
    expect(addDaysIso('2030-01-31', 14)).toBe('2030-02-14');
    expect(addDaysIso('2030-12-25', 10)).toBe('2031-01-04');
  });
});

describe('splitting money', () => {
  it('a payment pays the invoice first and the excess becomes credit', () => {
    expect(splitPayment(3000, 10_000)).toEqual({ applied: 3000, credited: 0 });
    expect(splitPayment(10_000, 10_000)).toEqual({ applied: 10_000, credited: 0 });
    expect(splitPayment(6000, 5000)).toEqual({ applied: 5000, credited: 1000 });
    expect(splitPayment(6000, 0)).toEqual({ applied: 0, credited: 6000 });
  });
  it('refuses nonsense amounts', () => {
    for (const a of [0, -1, 1.5, NaN, MAX_AMOUNT_CENTS + 1]) expect(() => splitPayment(a, 100)).toThrow(AppError);
  });

  it('credit notes reduce the invoice and put any excess on the account', () => {
    expect(splitCreditNote(2000, 5000)).toEqual({ applied: 2000, credited: 0 });
    expect(splitCreditNote(2000, 500)).toEqual({ applied: 500, credited: 1500 });
    expect(splitCreditNote(2000, 0)).toEqual({ applied: 0, credited: 2000 });
  });

  const pay = (over = {}) => ({ amountCents: 6000, appliedCents: 5000, creditedCents: 1000, refundedAppliedCents: 0, refundedCreditCents: 0, ...over });

  it('refunds take credit back first, then reopen the invoice', () => {
    expect(splitRefund(1000, pay(), 1000)).toEqual({ fromCredit: 1000, fromInvoice: 0 });
    expect(splitRefund(3000, pay(), 1000)).toEqual({ fromCredit: 1000, fromInvoice: 2000 });
    expect(splitRefund(6000, pay(), 1000)).toEqual({ fromCredit: 1000, fromInvoice: 5000 });
  });
  it('refunds can never exceed what is refundable', () => {
    expect(() => splitRefund(6001, pay(), 1000)).toThrow(AppError);
    expect(() => splitRefund(1, pay({ refundedAppliedCents: 5000, refundedCreditCents: 1000 }), 1000)).toThrow(AppError);
    expect(refundableOf(pay({ refundedAppliedCents: 2000 }))).toBe(4000);
    expect(() => splitRefund(0, pay(), 0)).toThrow(AppError);
  });
  it('credit that has been spent cannot be refunded as credit', () => {
    // Customer spent the R1000 credit elsewhere: only the invoice portion can come back.
    expect(() => splitRefund(6000, pay(), 0)).toThrow(AppError);
    expect(splitRefund(5000, pay(), 0)).toEqual({ fromCredit: 0, fromInvoice: 5000 });
  });
  it('payment status follows refunds', () => {
    expect(paymentStatusAfterRefund(pay())).toBe('COMPLETED');
    expect(paymentStatusAfterRefund(pay({ refundedAppliedCents: 100 }))).toBe('PARTIALLY_REFUNDED');
    expect(paymentStatusAfterRefund(pay({ refundedAppliedCents: 5000, refundedCreditCents: 1000 }))).toBe('REFUNDED');
  });
});

describe('state machines', () => {
  it('payments only move forward', () => {
    expect(canMovePayment('PENDING', 'COMPLETED')).toBe(true);
    expect(canMovePayment('PENDING', 'FAILED')).toBe(true);
    expect(canMovePayment('COMPLETED', 'PENDING')).toBe(false);
    expect(canMovePayment('COMPLETED', 'FAILED')).toBe(false);
    expect(canMovePayment('REFUNDED', 'COMPLETED')).toBe(false);
    expect(canMovePayment('COMPLETED', 'PARTIALLY_REFUNDED')).toBe(true);
  });
  it('quotes cannot jump to arbitrary statuses', () => {
    expect(canMoveQuote('DRAFT', 'SENT')).toBe(true);
    expect(canMoveQuote('DRAFT', 'DECLINED')).toBe(false);
    expect(canMoveQuote('DRAFT', 'CONVERTED')).toBe(false);
    expect(canMoveQuote('SENT', 'APPROVED')).toBe(true);
    expect(canMoveQuote('DECLINED', 'APPROVED')).toBe(false);
    expect(canMoveQuote('EXPIRED', 'APPROVED')).toBe(false);
    expect(canMoveQuote('CONVERTED', 'CANCELLED')).toBe(false);
    expect(canMoveQuote('CANCELLED', 'DRAFT')).toBe(false);
    expect(canMoveQuote('APPROVED', 'DRAFT')).toBe(false);
  });
});

describe('reminder schedule', () => {
  const offsets = [-3, 0, 7];
  it('sends nothing before the first threshold', () => {
    expect(dueReminder(-10, offsets, 0)).toBeNull();
  });
  it('picks the most recent threshold passed', () => {
    expect(dueReminder(-3, offsets, 0)).toMatchObject({ key: 'offset:-3', when: 'before' });
    expect(dueReminder(-1, offsets, 0)).toMatchObject({ key: 'offset:-3' });
    expect(dueReminder(0, offsets, 0)).toMatchObject({ key: 'offset:0', when: 'today' });
    expect(dueReminder(7, offsets, 0)).toMatchObject({ key: 'offset:7', when: 'overdue' });
    expect(dueReminder(3, offsets, 0)).toMatchObject({ key: 'offset:0', when: 'overdue' }); // 3 days late: the wording says overdue, not "due today"
    expect(dueReminder(-1, offsets, 0)).toMatchObject({ key: 'offset:-3', when: 'before' });
  });
  it('never sends a threshold that passed long ago', () => {
    expect(dueReminder(30, offsets, 0)).toBeNull();
    expect(dueReminder(15, offsets, 0)).toBeNull();
    expect(dueReminder(14, offsets, 0)).toMatchObject({ key: 'offset:7' }); // still within a week of the threshold
  });
  it('repeats overdue reminders after the last offset when asked to', () => {
    expect(dueReminder(7, offsets, 7)).toMatchObject({ key: 'offset:7' });
    expect(dueReminder(14, offsets, 7)).toMatchObject({ key: 'repeat:1', when: 'overdue' });
    expect(dueReminder(21, offsets, 7)).toMatchObject({ key: 'repeat:2' });
    expect(dueReminder(35, offsets, 7)).toMatchObject({ key: 'repeat:4' });
    expect(dueReminder(16, offsets, 7)).toMatchObject({ key: 'repeat:1' });
  });
});
