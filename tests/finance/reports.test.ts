import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { todayIso } from '@/lib/tz';
import { createCreditNote, issueCreditNote } from '@/server/finance/creditnotes';
import { exportFinanceData } from '@/server/finance/exports';
import { getCustomerFinancials, getVehicleFinancials } from '@/server/finance/insights';
import { refundPayment, getCustomerCredit } from '@/server/finance/payments';
import { approveQuoteOnBehalf, createQuote, sendQuote } from '@/server/finance/quotes';
import { getAgeingDetail, getFinanceDashboard, getPaymentAnalytics, getProfitability, getQuoteAnalytics, getVatReport } from '@/server/finance/reports';
import { searchFinance } from '@/server/finance/search';
import { getStatement, getStatementPdf } from '@/server/finance/statements';
import { getFinanceSettings } from '@/server/finance/settings';
import { globalSearch } from '@/server/search/service';
import { createMemberCtx, createWorkspace, ownerQuery, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice, party, pay, pdfText } from '../helpers/finance';

afterAll(disconnectPrisma);

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

let ws: TestWorkspace;
const ids: Record<string, string> = {};
let A: Awaited<ReturnType<typeof party>>;
let B: Awaited<ReturnType<typeof party>>;
const today = () => todayIso('Africa/Johannesburg');
const WIDE = { from: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10), to: todayIso('Africa/Johannesburg') };

/**
 * A small, fully known set of books (15% VAT):
 *   A: inv1  R1,000 +VAT = R1,150  paid in full (EFT)         credit note R100 + VAT = R115 (all to credit: invoice was paid)
 *   A: inv2  R2,000 +VAT = R2,300  due 40 days ago, unpaid    (labour 2h, cost R500/h)
 *   B: inv3  R  500 +VAT = R  575  due in 5 days, R200 cash paid, R50 of that refunded (part has no cost recorded)
 *   B: inv4  R  800 +VAT = R  920  due 100 days ago, unpaid
 */
beforeAll(async () => {
  ws = await financeWorkspace('Reports Workshop', { vat: true });
  A = await party(ws, 'Alice');
  B = await party(ws, 'Bob');
  const inv1 = await issuedInvoice(ws, { customerId: A.customer.id, vehicleId: A.vehicle.id, lines: [L('Brake pads', 1, 100_000, { unitCostCents: 60_000 })], send: true });
  const inv2 = await issuedInvoice(ws, { customerId: A.customer.id, vehicleId: A.vehicle.id, lines: [L('Labour', 2, 100_000, { lineType: 'LABOUR', unitCostCents: 50_000 })], dueInDays: -40 });
  const inv3 = await issuedInvoice(ws, { customerId: B.customer.id, vehicleId: B.vehicle.id, lines: [L('Wipers', 1, 50_000)], dueInDays: 5 });
  const inv4 = await issuedInvoice(ws, { customerId: B.customer.id, vehicleId: B.vehicle.id, lines: [L('Battery', 1, 80_000, { unitCostCents: 30_000 })], dueInDays: -100 });
  Object.assign(ids, { inv1: inv1.id, inv2: inv2.id, inv3: inv3.id, inv4: inv4.id, n1: inv1.number, n2: inv2.number, n3: inv3.number, n4: inv4.number });
  await pay(ws, inv1.id, 115_000, 'EFT', { reference: 'EFT-ALICE-1' });
  const p3 = await pay(ws, inv3.id, 20_000, 'CASH');
  await refundPayment(ws.ctx, p3.id, { amountCents: 5000, reason: 'Wrong wipers' });
  const cn = await createCreditNote(ws.ctx, { invoiceId: inv1.id, reason: 'Pads returned', lines: [L('Pads returned', 1, 10_000)] });
  await issueCreditNote(ws.ctx, cn.id);
  // quotes: one approved, one still open, one declined-by-nobody draft
  const q1 = await createQuote(ws.ctx, { customerId: A.customer.id, lines: [L('Service', 1, 100_000)] });
  await sendQuote(ws.ctx, q1.id);
  await approveQuoteOnBehalf(ws.ctx, q1.id, { method: 'PHONE', version: 1 });
  const q2 = await createQuote(ws.ctx, { customerId: B.customer.id, lines: [L('Tyres', 4, 100_000)] });
  await sendQuote(ws.ctx, q2.id);
  await createQuote(ws.ctx, { customerId: B.customer.id, lines: [L('Draft only', 1, 1000)] });
});

describe('the finance dashboard', () => {
  it('computes revenue, receivables, ageing and cash from the real records', async () => {
    const d = await getFinanceDashboard(ws.ctx, WIDE);
    // revenue = invoiced ex VAT (1000+2000+500+800) less credit notes (100) = R4,200; this is NOT cash
    expect(d.revenue.rangeCents).toBe(420_000);
    expect(d.invoiced).toMatchObject({ countInRange: 4, totalInRangeCents: 115_000 + 230_000 + 57_500 + 92_000, creditNotesInRangeCents: 11_500 });
    expect(d.invoiced.vatInRangeCents).toBe(64_500);
    expect(d.invoiced.averageInvoiceCents).toBe(Math.round(430_000 / 4));
    // cash received: R1,150 + R200; R50 refunded
    expect(d.received).toMatchObject({ rangeCents: 135_000, rangeCount: 2, refundedInRangeCents: 5000, netInRangeCents: 130_000 });
    // owed: inv2 2,300 + inv3 (575 - 200 + 50) 425 + inv4 920
    expect(d.receivables.outstandingCents).toBe(230_000 + 42_500 + 92_000);
    expect(d.receivables.openInvoices).toBe(3);
    expect(d.receivables.overdueCents).toBe(230_000 + 92_000);
    expect(d.receivables.currentCents).toBe(42_500);
    expect(d.receivables.ageing.current).toEqual({ count: 1, amountCents: 42_500 });
    expect(d.receivables.ageing.d1_30).toEqual({ count: 0, amountCents: 0 });
    expect(d.receivables.ageing.d31_60).toEqual({ count: 1, amountCents: 230_000 });
    expect(d.receivables.ageing.d61_90).toEqual({ count: 0, amountCents: 0 });
    expect(d.receivables.ageing.d90_plus).toEqual({ count: 1, amountCents: 92_000 });
    expect(d.quotes).toMatchObject({ pendingCount: 1, pendingValueCents: 4 * 100_000 + 60_000 });
    expect(d.invoiced.paidInRange).toBe(1);
  });

  it('keeps revenue and cash apart, and respects the date range', async () => {
    const none = await getFinanceDashboard(ws.ctx, { from: '2020-01-01', to: '2020-12-31' });
    expect(none.revenue.rangeCents).toBe(0);
    expect(none.received.rangeCents).toBe(0);
    expect(none.receivables.outstandingCents).toBe(230_000 + 42_500 + 92_000); // receivables are "as of now", not "of the period"
    const todayOnly = await getFinanceDashboard(ws.ctx, { from: today(), to: today() });
    expect(todayOnly.received.todayCents).toBe(135_000);
    expect(todayOnly.received.rangeCents).toBe(135_000);
    expect((await getFinanceDashboard(ws.ctx, {})).revenue.todayCents).toBeGreaterThanOrEqual(0);
    expect((await err(getFinanceDashboard(ws.ctx, { from: '2030-01-02', to: '2030-01-01' }))).code).toBe('VALIDATION_ERROR');
    expect((await err(getFinanceDashboard(ws.ctx, { from: 'yesterday' }))).code).toBe('VALIDATION_ERROR');
  });

  it('lists the ageing detail with the bucket of every open invoice', async () => {
    const all = await getAgeingDetail(ws.ctx, {});
    expect(all.items.map((i) => [i.number, i.bucket])).toEqual(expect.arrayContaining([[ids.n4, 'd90_plus'], [ids.n2, 'd31_60'], [ids.n3, 'current']]));
    expect(all.items).toHaveLength(3);
    expect((await getAgeingDetail(ws.ctx, { bucket: 'd90_plus' })).items.map((i) => i.number)).toEqual([ids.n4]);
    expect(all.items.every((i) => i.outstandingCents > 0)).toBe(true); // paid invoices never appear
  });
});

describe('quote and payment analytics', () => {
  it('counts quotes by status with approval rates', async () => {
    const q = await getQuoteAnalytics(ws.ctx, WIDE);
    expect(q.counts).toMatchObject({ total: 3, draft: 1, sent: 1, approved: 1, declined: 0, expired: 0, converted: 0 });
    expect(q.approvalRatePct).toBe(50); // 1 approved of 2 sent
    expect(q.declineRatePct).toBe(0);
    expect(q.approvedValueCents).toBe(115_000);
    expect(q.outstandingValueCents).toBe(460_000);
    expect(q.averageQuoteValueCents).toBe(Math.round((115_000 + 460_000) / 2));
  });

  it('breaks payments down by method and shows refunds and credit', async () => {
    const p = await getPaymentAnalytics(ws.ctx, WIDE);
    expect(p.totalReceivedCents).toBe(135_000);
    expect(p.paymentCount).toBe(2);
    expect(p.byMethod.find((m) => m.method === 'EFT')).toEqual({ method: 'EFT', count: 1, amountCents: 115_000 });
    expect(p.byMethod.find((m) => m.method === 'CASH')).toEqual({ method: 'CASH', count: 1, amountCents: 20_000 });
    expect(p.byMethod.find((m) => m.method === 'ONLINE')).toEqual({ method: 'ONLINE', count: 0, amountCents: 0 });
    expect(p.refundedCents).toBe(5000);
    expect(p.creditIssuedCents).toBe(11_500);
    expect(p.outstandingCents).toBe(230_000 + 42_500 + 92_000);
  });
});

describe('profitability and VAT', () => {
  it('works out operational gross profit from costs recorded on the invoice lines, and says what it could not cost', async () => {
    const p = await getProfitability(ws.ctx, WIDE);
    expect(p.revenueCents).toBe(430_000);
    expect(p.partsCostCents).toBe(60_000 + 30_000);
    expect(p.labourCostCents).toBe(100_000);
    expect(p.totalCostCents).toBe(190_000);
    expect(p.grossProfitCents).toBe(240_000);
    expect(p.grossMarginPct).toBe(55.8);
    expect(p.uncostedLines).toBe(1);
    expect(p.uncostedRevenueCents).toBe(50_000);
    expect(p.byLineType.find((r) => r.lineType === 'LABOUR')).toMatchObject({ revenueCents: 200_000, costCents: 100_000, profitCents: 100_000 });
  });

  it('retains the VAT facts for an accountant without being a VAT return', async () => {
    const v = await getVatReport(ws.ctx, WIDE);
    expect(v.vatRegistered).toBe(true);
    expect(v.invoices).toEqual([{ treatment: 'STANDARD', rateBps: 1500, taxableCents: 430_000, vatCents: 64_500, documents: 4 }]);
    expect(v.creditNotes).toEqual([{ treatment: 'STANDARD', rateBps: 1500, taxableCents: 10_000, vatCents: 1500, documents: 1 }]);
    expect(v.outputVatCents).toBe(63_000);
    expect(v.taxableSalesCents).toBe(420_000);
    expect(v.note).toMatch(/not a VAT return/);
  });

  it('are gated by plan and by permission, server-side', async () => {
    const solo = await financeWorkspace('Solo Reports');
    await upgradePlan(solo, 'solo');
    expect((await getFinanceDashboard(solo.ctx, {})).revenue).toBeDefined(); // the basic dashboard is on every plan
    for (const fn of [getQuoteAnalytics, getPaymentAnalytics, getProfitability, getVatReport]) expect((await err(fn(solo.ctx, {}))).code).toBe('FEATURE_NOT_IN_PLAN');
    const advisor = await createMemberCtx(ws, 'service_advisor');
    expect((await err(getFinanceDashboard(advisor.ctx, {}))).code).toBe('FORBIDDEN');
    const manager = await createMemberCtx(ws, 'manager');
    expect((await getFinanceDashboard(manager.ctx, {})).revenue).toBeDefined();
    expect((await err(getProfitability(manager.ctx, {}))).code).toBe('FORBIDDEN'); // no cost visibility
    const accounts = await createMemberCtx(ws, 'accounts');
    expect((await getProfitability(accounts.ctx, WIDE)).grossProfitCents).toBe(240_000);
  });
});

describe('statements', () => {
  it('shows a customer\'s account with opening and closing balances that agree with what they owe', async () => {
    const a = await getStatement(ws.ctx, A.customer.id, WIDE);
    expect(a.openingCents).toBe(0);
    expect(a.rows.map((r) => [r.type, r.chargeCents, r.creditCents])).toEqual(expect.arrayContaining([['invoice', 115_000, 0], ['invoice', 230_000, 0], ['payment', 0, 115_000], ['credit_note', 0, 11_500]]));
    // owes R2,300 on inv2, holds R115 credit: net R2,185
    expect(a.closingCents).toBe(230_000 - 11_500);
    expect(a.creditAvailableCents).toBe(11_500);
    // running balance is arithmetic
    let bal = a.openingCents;
    for (const r of a.rows) { bal += r.chargeCents - r.creditCents; expect(r.balanceCents).toBe(bal); }
    const b = await getStatement(ws.ctx, B.customer.id, WIDE);
    expect(b.rows.map((r) => r.type)).toEqual(expect.arrayContaining(['invoice', 'payment', 'refund']));
    expect(b.closingCents).toBe(42_500 + 92_000); // exactly what they owe on inv3 and inv4
  });

  it('carries the balance forward into later periods', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);
    const later = await getStatement(ws.ctx, A.customer.id, { from: tomorrow, to: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) });
    expect(later.rows).toHaveLength(0);
    expect(later.openingCents).toBe(230_000 - 11_500);
    expect(later.closingCents).toBe(later.openingCents);
  });

  it('every customer\'s statement agrees with their receivables less credit (a consistency sweep)', async () => {
    for (const c of [A.customer.id, B.customer.id]) {
      const s = await getStatement(ws.ctx, c, WIDE);
      const open = await ownerQuery<{ s: string }>('SELECT COALESCE(SUM(outstanding_cents),0) AS s FROM invoices WHERE customer_id = $1 AND finalised_at IS NOT NULL AND cancelled_at IS NULL AND written_off_at IS NULL', [c]);
      expect(s.closingCents).toBe(Number(open.rows[0]!.s) - (await getCustomerCredit(ws.ctx, c)).balanceCents);
    }
  });

  it('renders a PDF statement without internal information, and files it', async () => {
    const { pdf, filename } = await getStatementPdf(ws.ctx, A.customer.id, WIDE);
    expect(filename).toMatch(/^statement-.*\.pdf$/);
    const text = pdfText(pdf);
    for (const s of ['STATEMENT', 'Opening balance', ids.n1!, ids.n2!, 'Credit note', 'Balance due', 'Credit available']) expect(text, s).toContain(s);
    expect(text).not.toMatch(/cost/i);
    expect((await ownerQuery("SELECT 1 FROM files WHERE resource_type = 'statement' AND resource_id = $1", [A.customer.id])).rows.length).toBeGreaterThan(0);
    const other = await createWorkspace('Statement Spy');
    expect((await err(getStatement(other.ctx, A.customer.id, WIDE))).code).toBe('NOT_FOUND');
    expect((await err(getStatementPdf(other.ctx, A.customer.id, WIDE))).code).toBe('NOT_FOUND');
  });
});

describe('customer and vehicle financial profiles', () => {
  it('summarises a customer from the transaction records', async () => {
    const f = (await getCustomerFinancials(ws.ctx, A.customer.id)) as Record<string, any>;
    expect(f.totals).toMatchObject({ invoicedCents: 115_000 + 230_000, paidCents: 115_000, outstandingCents: 230_000, overdueCents: 230_000, overdueCount: 1, creditNotedCents: 11_500, invoiceCount: 2 });
    expect(f.creditBalanceCents).toBe(11_500);
    expect(f.openInvoices.map((i: any) => i.number)).toEqual([ids.n2]);
    expect(f.openInvoices[0].overdue).toBe(true);
    expect(f.paidInvoices.map((i: any) => i.number)).toEqual([ids.n1]);
    expect(f.recentPayments[0]).toMatchObject({ method: 'EFT', amountCents: 115_000 });
    expect(f.quotes).toHaveLength(1);
    expect(f.creditNotes).toHaveLength(1);
    expect(f.accountBalanceCents).toBe(230_000 - 11_500);
    const g = (await getCustomerFinancials(ws.ctx, B.customer.id)) as Record<string, any>;
    expect(g.totals).toMatchObject({ invoicedCents: 57_500 + 92_000, outstandingCents: 42_500 + 92_000 });
    expect(g.refunds).toHaveLength(1);
  });

  it('shows a vehicle its own spend without mixing in the customer\'s other accounts', async () => {
    const v = (await getVehicleFinancials(ws.ctx, A.vehicle.id)) as Record<string, any>;
    expect(v.totals).toMatchObject({ invoicedCents: 345_000, spendExVatCents: 300_000, paidCents: 115_000, outstandingCents: 230_000, invoiceCount: 2 });
    expect(v.invoices).toHaveLength(2);
    expect(v.payments).toHaveLength(1);
    const w = (await getVehicleFinancials(ws.ctx, B.vehicle.id)) as Record<string, any>;
    expect(w.totals.invoicedCents).toBe(57_500 + 92_000);
  });

  it('hides sections the caller may not see, and other businesses entirely', async () => {
    const advisor = await createMemberCtx(ws, 'service_advisor');
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(getCustomerFinancials(tech.ctx, A.customer.id))).code).toBe('FORBIDDEN');
    const f = (await getCustomerFinancials(advisor.ctx, A.customer.id)) as Record<string, any>;
    expect(f.recentPayments).toBeDefined();
    expect(f.creditNotes).toBeUndefined(); // advisors cannot see credit notes
    const other = await createWorkspace('Profile Spy');
    expect((await err(getCustomerFinancials(other.ctx, A.customer.id))).code).toBe('NOT_FOUND');
    expect((await err(getVehicleFinancials(other.ctx, A.vehicle.id))).code).toBe('NOT_FOUND');
  });
});

describe('searching money records', () => {
  it('finds records by number, reference, customer, phone, email, registration and VIN, with every word having to match', async () => {
    await ownerQuery("UPDATE vehicles SET vin = 'WVWZZZ1JZ3W386752' WHERE id = $1", [A.vehicle.id]);
    const titles = async (q: string) => (await searchFinance(ws.ctx, { q })).flatMap((g) => g.items.map((i) => `${g.key}:${i.title}`));
    expect((await titles(ids.n1!)).some((t) => t.startsWith('invoices:') && t.includes(ids.n1!))).toBe(true);
    expect((await titles('EFT-ALICE-1')).some((t) => t.startsWith('payments:'))).toBe(true);
    const receipt = (await ownerQuery<{ number: string }>('SELECT number FROM receipts WHERE business_id = $1 ORDER BY number LIMIT 1', [ws.businessId])).rows[0]!.number;
    expect((await titles(receipt)).some((t) => t.startsWith('payments:'))).toBe(true);
    const cnNumber = (await ownerQuery<{ number: string }>("SELECT number FROM credit_notes WHERE business_id = $1 AND status = 'ISSUED' LIMIT 1", [ws.businessId])).rows[0]!.number;
    expect((await titles(cnNumber)).some((t) => t.startsWith('credit_notes:'))).toBe(true);
    const quoteNumber = (await ownerQuery<{ number: string }>('SELECT number FROM quotes WHERE business_id = $1 LIMIT 1', [ws.businessId])).rows[0]!.number;
    expect((await titles(quoteNumber)).some((t) => t.startsWith('quotes:'))).toBe(true);
    expect((await titles('Alice')).length).toBeGreaterThan(2);
    expect((await titles('alice credit')).some((t) => t.startsWith('credit_notes:'))).toBe(false); // "credit" is not in their name or number
    expect((await titles('Alice Bob')).length).toBe(0); // both words must match one record
    const phone = '082 000 0000';
    expect((await titles(phone)).length).toBeGreaterThan(0);
    const email = (await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [A.customer.id])).rows[0]!.email;
    expect((await titles(email)).some((t) => t.includes('Alice'))).toBe(true);
    expect((await titles(A.vehicle.registration!)).some((t) => t.startsWith('invoices:'))).toBe(true);
    expect((await titles('WVWZZZ1JZ3W386752')).some((t) => t.startsWith('invoices:'))).toBe(true);
    expect((await titles('%%')).length).toBe(0); // wildcards are matched literally
  });

  it('only searches what the caller may see, and only this business', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect(await searchFinance(tech.ctx, { q: ids.n1 })).toEqual([]);
    const advisor = await createMemberCtx(ws, 'service_advisor');
    const keys = (await searchFinance(advisor.ctx, { q: 'Alice' })).map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(['invoices', 'quotes']));
    expect(keys).not.toContain('credit_notes');
    const other = await createWorkspace('Search Spy');
    expect(await searchFinance(other.ctx, { q: 'Alice' })).toEqual([]);
    expect((await globalSearch(ws.ctx, { q: ids.n2 })).some((g) => g.key === 'invoices')).toBe(true); // also in global search
    expect((await err(searchFinance(ws.ctx, { q: 'a' }))).code).toBe('VALIDATION_ERROR');
  });
});

describe('exports', () => {
  it('exports invoices as CSV with exact money, and records the export in the audit log', async () => {
    const r = await exportFinanceData(ws.ctx, { dataset: 'invoices', format: 'csv', ...WIDE });
    expect(r.filename).toMatch(/^tfme-auto-invoices-.*\.csv$/);
    expect(r.rows).toBe(4);
    const text = r.data.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff); // BOM so Excel reads accents
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toContain('Invoice number');
    expect(lines).toHaveLength(5);
    const inv2 = lines.find((l) => l.startsWith(ids.n2!))!;
    expect(inv2).toContain('2300.00');
    expect(text).not.toMatch(/,\d+\.\d{3,},/); // no float artefacts in money columns
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'finance.exported' ORDER BY created_at DESC LIMIT 1", [ws.businessId]);
    expect(audit.rows[0]!.metadata).toMatchObject({ dataset: 'invoices', format: 'csv', rows: 4 });
  });

  it('exports Excel files, payments, credit notes, VAT lines and ageing', async () => {
    const x = await exportFinanceData(ws.ctx, { dataset: 'payments', format: 'xlsx', ...WIDE });
    expect(x.filename.endsWith('.xlsx')).toBe(true);
    expect(x.mime).toContain('spreadsheetml');
    expect(x.data.subarray(0, 2).toString()).toBe('PK');
    const raw = x.data.toString('latin1');
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) expect(raw).toContain(part);
    expect(raw).toContain('<v>1150.00</v>');
    expect(raw).toContain('EFT-ALICE-1');
    expect((await exportFinanceData(ws.ctx, { dataset: 'credit_notes', ...WIDE })).rows).toBe(1);
    expect((await exportFinanceData(ws.ctx, { dataset: 'receipts', ...WIDE })).rows).toBe(2);
    expect((await exportFinanceData(ws.ctx, { dataset: 'quotes', ...WIDE })).rows).toBe(3);
    const vat = await exportFinanceData(ws.ctx, { dataset: 'vat', ...WIDE });
    expect(vat.rows).toBe(5); // 4 invoices + 1 credit note (one tax rate each)
    expect(vat.data.toString('utf8')).toContain('-100.00'); // the credit note reduces VAT-able sales
    const ageing = await exportFinanceData(ws.ctx, { dataset: 'ageing', ...WIDE });
    expect(ageing.rows).toBe(3);
    expect(ageing.data.toString('utf8')).toContain('90+ days overdue');
    const lines = await exportFinanceData(ws.ctx, { dataset: 'invoice_lines', ...WIDE });
    expect(lines.rows).toBe(4);
    expect(lines.data.toString('utf8')).toContain('Unit cost'); // accounts can see costs
  });

  it('respects filters (period, status, customer)', async () => {
    expect((await exportFinanceData(ws.ctx, { dataset: 'invoices', from: '2020-01-01', to: '2020-12-31' })).rows).toBe(0);
    expect((await exportFinanceData(ws.ctx, { dataset: 'invoices', customerId: A.customer.id, ...WIDE })).rows).toBe(2);
    expect((await exportFinanceData(ws.ctx, { dataset: 'invoices', status: 'PAID', ...WIDE })).rows).toBe(1);
    expect((await err(exportFinanceData(ws.ctx, { dataset: 'invoices', from: '2030-02-01', to: '2030-01-01' }))).code).toBe('VALIDATION_ERROR');
    expect((await err(exportFinanceData(ws.ctx, { dataset: 'nonsense' }))).code).toBe('VALIDATION_ERROR');
  });

  it('defuses spreadsheet formulas in customer-supplied text', async () => {
    const w = await financeWorkspace('Formula Shop');
    const p = await party(w, 'Evil');
    await ownerQuery("UPDATE customers SET name = '=HYPERLINK(\"http://evil.test\",\"click\")' WHERE id = $1", [p.customer.id]);
    await issuedInvoice(w, { customerId: p.customer.id, vehicleId: p.vehicle.id });
    const csv = (await exportFinanceData(w.ctx, { dataset: 'invoices', ...WIDE })).data.toString('utf8');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,=HYPERLINK/);
    const xlsx = (await exportFinanceData(w.ctx, { dataset: 'invoices', format: 'xlsx', ...WIDE })).data.toString('latin1');
    expect(xlsx).toContain("'=HYPERLINK");
  });

  it('is limited to people who may export finance data and see that kind of record; costs stay hidden from those who cannot see them', async () => {
    const advisor = await createMemberCtx(ws, 'service_advisor');
    expect((await err(exportFinanceData(advisor.ctx, { dataset: 'invoices' }))).code).toBe('FORBIDDEN');
    const manager = await createMemberCtx(ws, 'manager');
    expect((await err(exportFinanceData(manager.ctx, { dataset: 'invoices' }))).code).toBe('FORBIDDEN'); // no finance.export
    const accounts = await createMemberCtx(ws, 'accounts');
    expect((await exportFinanceData(accounts.ctx, { dataset: 'invoices', ...WIDE })).rows).toBe(4);
    // a custom role that may export but not see costs
    const { memberWithPermissions } = await import('../helpers/workshop');
    const noCosts = await memberWithPermissions(ws, ['finance.export', 'invoice.view']);
    expect((await exportFinanceData(noCosts.ctx, { dataset: 'invoice_lines', ...WIDE })).data.toString('utf8')).not.toContain('Unit cost');
    expect((await err(exportFinanceData(noCosts.ctx, { dataset: 'payments' }))).code).toBe('FORBIDDEN'); // lacks payment.view
  });

  it('exports only this business\'s records', async () => {
    const other = await financeWorkspace('Export Neighbour');
    await issuedInvoice(other);
    const mine = await exportFinanceData(ws.ctx, { dataset: 'invoices', ...WIDE });
    const theirs = await exportFinanceData(other.ctx, { dataset: 'invoices', ...WIDE });
    expect(mine.rows).toBe(4);
    expect(theirs.rows).toBe(1);
    expect(theirs.data.toString('utf8')).not.toContain(ids.n1!.replace('INV-', 'ZZZ'));
    expect(mine.data.toString('utf8')).not.toContain('Export Neighbour');
  });
});

describe('settings view', () => {
  it('shows the numbering and terms in use', async () => {
    const s = await getFinanceSettings(ws.ctx);
    expect(s).toMatchObject({ invoicePrefix: 'INV', quotePrefix: 'QUO', paymentPrefix: 'PAY', receiptPrefix: 'RCT', creditNotePrefix: 'CN', numberPadding: 6, paymentTermsDays: 14, quoteValidityDays: 14 });
    expect(s.enabledMethods).toEqual(expect.arrayContaining(['CARD', 'EFT', 'CASH']));
  });
});
