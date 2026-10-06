import { describe, expect, it } from 'vitest';
import {
  allocate, centsToDecimal, computeDocumentTotals, discountAmount, formatMoney, lineAmount,
  MoneyError, parseDecimalToCents, parseQuantityToMilli, vatFromInclusive, vatOnExclusive,
} from '@/lib/money';

describe('parsing', () => {
  it('parses decimals to exact cents without float error', () => {
    expect(parseDecimalToCents('0.1')).toBe(10);
    expect(parseDecimalToCents('0.29')).toBe(29); // 0.29 * 100 === 28.999... in floats
    expect(parseDecimalToCents('1234.5')).toBe(123_450);
    expect(parseDecimalToCents('-12.30')).toBe(-1230);
  });
  it('rejects junk and over-precise amounts', () => {
    for (const bad of ['', 'abc', '1.234', '1,50', '1e3', '--1', '1.']) {
      expect(() => parseDecimalToCents(bad)).toThrow(MoneyError);
    }
  });
  it('parses quantities to thousandths', () => {
    expect(parseQuantityToMilli('1.5')).toBe(1500);
    expect(parseQuantityToMilli('0.125')).toBe(125);
    expect(() => parseQuantityToMilli('1.2345')).toThrow(MoneyError);
  });
  it('formats cents as plain decimals', () => {
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-123_456)).toBe('-1234.56');
  });
  it('formats ZAR for display', () => {
    expect(formatMoney(123_450)).toMatch(/R\s?1[\s ]234,50/);
  });
});

describe('line amounts, discounts and VAT', () => {
  it('multiplies quantity by price with half-away-from-zero rounding', () => {
    expect(lineAmount(1500, 1000)).toBe(1500); // 1.5 h x R10.00
    expect(lineAmount(333, 100)).toBe(33); // 0.333 x R1.00 = 33.3c
    expect(lineAmount(335, 100)).toBe(34); // 33.5c rounds up
    expect(lineAmount(-335, 100)).toBe(-34); // symmetrical for credits
  });
  it('computes discount in basis points', () => {
    expect(discountAmount(10_000, 1000)).toBe(1000); // 10%
    expect(() => discountAmount(100, 10_001)).toThrow(MoneyError);
  });
  it('adds 15% VAT to exclusive amounts', () => {
    expect(vatOnExclusive(10_000, 1500)).toBe(1500);
    expect(vatOnExclusive(99_900, 1500)).toBe(14_985);
    expect(vatOnExclusive(1, 1500)).toBe(0);
    expect(vatOnExclusive(3, 1500)).toBe(0); // 0.45c
    expect(vatOnExclusive(4, 1500)).toBe(1); // 0.6c
  });
  it('extracts VAT from inclusive amounts', () => {
    expect(vatFromInclusive(11_500, 1500)).toBe(1500);
    expect(vatFromInclusive(11_499, 1500)).toBe(1500); // net 9999 (9999.13 rounded), VAT = 11499 - 9999
  });
  it('inclusive extraction always satisfies net + vat = gross', () => {
    for (const gross of [1, 99, 100, 115, 11_499, 999_999, 12_345_678]) {
      const vat = vatFromInclusive(gross, 1500);
      expect(gross - vat + vat).toBe(gross);
      expect(vat).toBeGreaterThanOrEqual(0);
      expect(vat).toBeLessThanOrEqual(gross);
    }
  });
});

describe('document totals', () => {
  const vat = { vatRegistered: true, vatRateBps: 1500 };

  it('totals a workshop invoice deterministically', () => {
    const t = computeDocumentTotals(
      [
        { qtyMilli: 2000, unitPriceCents: 85_000 }, // 2.0 h labour @ R850
        { qtyMilli: 1000, unitPriceCents: 45_000 }, // oil filter R450
        { qtyMilli: 4500, unitPriceCents: 12_000, discountBps: 1000 }, // 4.5 L oil @ R120, 10% off
      ],
      vat,
    );
    // 170000 + 45000 + (54000 - 5400) = 263600 ; VAT 15% = 39540
    expect(t).toEqual({ subtotalCents: 263_600, discountCents: 5400, vatCents: 39_540, totalCents: 303_140 });
  });
  it('is reproducible: same inputs, same outputs, every time', () => {
    const lines = [{ qtyMilli: 3333, unitPriceCents: 1999, discountBps: 250 }, { qtyMilli: 1000, unitPriceCents: 333 }];
    const first = computeDocumentTotals(lines, vat);
    for (let i = 0; i < 50; i++) expect(computeDocumentTotals(lines, vat)).toEqual(first);
  });
  it('charges no VAT when the business is not VAT registered', () => {
    const t = computeDocumentTotals([{ qtyMilli: 1000, unitPriceCents: 10_000 }], { vatRegistered: false, vatRateBps: 1500 });
    expect(t).toMatchObject({ vatCents: 0, totalCents: 10_000 });
  });
  it('handles VAT-inclusive pricing so total equals the sum of gross lines', () => {
    const t = computeDocumentTotals([{ qtyMilli: 1000, unitPriceCents: 11_500 }], { ...vat, pricesIncludeVat: true });
    expect(t).toEqual({ subtotalCents: 10_000, discountCents: 0, vatCents: 1500, totalCents: 11_500 });
  });
  it('subtotal + vat always equals total', () => {
    const t = computeDocumentTotals([{ qtyMilli: 777, unitPriceCents: 1234 }, { qtyMilli: 3, unitPriceCents: 7 }], vat);
    expect(t.subtotalCents + t.vatCents).toBe(t.totalCents);
  });
  it('refuses unsafe numbers instead of silently losing precision', () => {
    expect(() => lineAmount(1.5, 100)).toThrow(MoneyError);
    expect(() => lineAmount(1000, Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
    expect(() => vatOnExclusive(100, -1)).toThrow(MoneyError);
  });
});

describe('allocate (split without losing a cent)', () => {
  it('splits evenly with the remainder distributed', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(5, [1, 1])).toEqual([3, 2]);
  });
  it('respects weights and always sums to the total', () => {
    const parts = allocate(10_001, [70, 20, 10]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10_001);
    expect(parts[0]).toBeGreaterThan(parts[1]!);
  });
  it('supports negative totals (credits) and zero weights', () => {
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100);
    expect(allocate(10, [0, 1])).toEqual([0, 10]);
  });
  it('rejects invalid weights', () => {
    expect(() => allocate(10, [])).toThrow(MoneyError);
    expect(() => allocate(10, [0, 0])).toThrow(MoneyError);
    expect(() => allocate(10, [-1, 2])).toThrow(MoneyError);
  });
});
