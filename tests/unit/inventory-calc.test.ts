import { describe, expect, it } from 'vitest';
import { availableOf, costAfterReceipt, margin, minutesBetween, orderStatusAfterReceipt, outstandingOf, stockState, suggestedReorder } from '@/server/inventory/calc';
import { parseCsv, readXlsx, readTable, TabularError } from '@/lib/tabular-read';
import { toXlsx, toCsv } from '@/lib/tabular';

describe('available, low and out of stock', () => {
  it('available is on hand minus reserved', () => {
    expect(availableOf(20, 5)).toBe(15);
    expect(availableOf(3, 3)).toBe(0);
    expect(availableOf(2, 5)).toBe(-3);
  });
  it('is out when nothing is available, low at or below the larger of the minimum and the reorder level', () => {
    expect(stockState(0, 5, null)).toBe('OUT');
    expect(stockState(-2, 0, null)).toBe('OUT');
    expect(stockState(5, 5, null)).toBe('LOW');
    expect(stockState(6, 5, null)).toBe('NORMAL');
    expect(stockState(8, 5, 10)).toBe('LOW');
    expect(stockState(11, 5, 10)).toBe('NORMAL');
    expect(stockState(1, 0, null)).toBe('NORMAL'); // no threshold set: only "out" matters
  });
  it('suggests the reorder quantity, else enough to clear the minimum', () => {
    expect(suggestedReorder(2, 10, null, 24)).toBe(24);
    expect(suggestedReorder(2, 10, null, null)).toBe(8);
    expect(suggestedReorder(12, 10, null, null)).toBe(0);
    expect(suggestedReorder(2, 5, 12, null)).toBe(10);
  });
});

describe('cost after a delivery', () => {
  it('last cost takes the new price; the average blends it with what is on hand, rounding half up', () => {
    expect(costAfterReceipt('LAST_COST', { onHand: 10, costCents: 10_000 }, 10, 12_000)).toBe(12_000);
    expect(costAfterReceipt('AVERAGE_COST', { onHand: 10, costCents: 10_000 }, 10, 12_000)).toBe(11_000);
    expect(costAfterReceipt('AVERAGE_COST', { onHand: 0, costCents: 10_000 }, 5, 12_000)).toBe(12_000);
    expect(costAfterReceipt('AVERAGE_COST', { onHand: 4, costCents: null }, 5, 12_000)).toBe(12_000);
    expect(costAfterReceipt('AVERAGE_COST', { onHand: 1, costCents: 100 }, 1, 101)).toBe(101); // 100.5 rounds up
    expect(costAfterReceipt('AVERAGE_COST', { onHand: 3, costCents: 1_000 }, 1, 2_000)).toBe(1_250);
  });
});

describe('margins and purchase order progress', () => {
  it('works out margin in cents and basis points', () => {
    expect(margin(10_000, 6_000)).toEqual({ marginCents: 4_000, marginBps: 4_000 });
    expect(margin(0, 500)).toEqual({ marginCents: -500, marginBps: null });
    expect(margin(3, 1)).toEqual({ marginCents: 2, marginBps: 6_667 });
  });
  it('an order is received only when nothing is outstanding', () => {
    const line = (o: number, r: number, c = 0) => ({ quantityOrdered: o, quantityReceived: r, quantityCancelled: c });
    expect(orderStatusAfterReceipt([line(20, 12)])).toBe('PARTIALLY_RECEIVED');
    expect(orderStatusAfterReceipt([line(20, 20)])).toBe('RECEIVED');
    expect(orderStatusAfterReceipt([line(20, 12, 8)])).toBe('RECEIVED');
    expect(orderStatusAfterReceipt([line(20, 20), line(5, 4)])).toBe('PARTIALLY_RECEIVED');
    expect(outstandingOf(line(100, 40))).toBe(60);
  });
  it('rounds minutes to the nearest minute', () => {
    expect(minutesBetween(new Date('2026-01-01T10:00:00Z'), new Date('2026-01-01T10:29:31Z'))).toBe(30);
    expect(minutesBetween(new Date('2026-01-01T10:00:00Z'), new Date('2026-01-01T10:00:20Z'))).toBe(0);
  });
});

describe('reading spreadsheets', () => {
  it('parses CSV with quotes, commas, newlines in cells, a BOM and semicolons', () => {
    expect(parseCsv('﻿a,b\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseCsv('a;b\r\n1;2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n"line\nbreak",2')).toEqual([['a', 'b'], ['line\nbreak', '2']]);
    expect(parseCsv('a,b\n\n,\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(() => parseCsv('a,b\n"unclosed,1')).toThrow(TabularError);
  });
  it('reads back the Excel files this app writes, text and numbers alike', () => {
    const buf = toXlsx('Parts', [{ header: 'SKU', kind: 'text' }, { header: 'Price', kind: 'money' }, { header: 'Qty', kind: 'int' }], [['A&B <1>', 12_345, 7], ['Ünï', null, 0]]);
    expect(readXlsx(buf)).toEqual([['SKU', 'Price', 'Qty'], ['A&B <1>', '123.45', '7'], ['Ünï', '', '0']]);
    expect(readTable(buf, 'x.xlsx')[1]![0]).toBe('A&B <1>');
    expect(readTable(toCsv([{ header: 'a', kind: 'text' }], [['1']]), 'x.csv')).toEqual([['a'], ['1']]);
  });
  it('rejects things that are not spreadsheets, and old .xls', () => {
    expect(() => readTable(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'x.xlsx')).toThrow(TabularError);
    expect(() => readTable(Buffer.alloc(0), 'x.csv')).toThrow(TabularError);
    expect(() => readTable(Buffer.from('a\u0000b'), 'x.csv')).toThrow(TabularError);
    expect(() => readTable(Buffer.from('a,b\n1,2'), 'old.xls')).toThrow(/xls/);
  });
});
