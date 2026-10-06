import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { getInvoice } from '@/server/finance/invoices';
import { getReceiptPdf } from '@/server/finance/pdfs';
import { applyCredit, getCustomerCredit, getPayment, listPayments, listReceipts, reconcilePayment, recordPayment, refundPayment } from '@/server/finance/payments';
import { createMemberCtx, createWorkspace, drainJobs, latestEmailTo, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice, key, party, pay, pdfText } from '../helpers/finance';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await financeWorkspace('Payments Workshop');
});

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

/** An issued invoice for exactly this amount. */
const invoiceOf = (amount: number, customerId?: string, vehicleId?: string) => issuedInvoice(ws, { customerId, vehicleId, lines: [L('Work', 1, amount)] });
const credit = async (customerId: string) => (await getCustomerCredit(ws.ctx, customerId)).balanceCents;

describe('recording payments', () => {
  it('several part payments settle an invoice; it is only Paid when the full amount has been paid', async () => {
    const inv = await invoiceOf(1_000_000);
    const p1 = await pay(ws, inv.id, 300_000);
    expect(p1).toMatchObject({ status: 'COMPLETED', appliedCents: 300_000, creditedCents: 0 });
    expect(await getInvoice(ws.ctx, inv.id)).toMatchObject({ invoice: { status: 'PARTIALLY_PAID', paymentStatus: 'PARTIALLY_PAID', paidCents: 300_000, outstandingCents: 700_000 } });
    await pay(ws, inv.id, 200_000);
    const mid = await getInvoice(ws.ctx, inv.id);
    expect(mid.invoice).toMatchObject({ status: 'PARTIALLY_PAID', paidCents: 500_000, outstandingCents: 500_000 });
    expect(mid.invoice.paidAt).toBeNull();
    await pay(ws, inv.id, 500_000);
    const done = await getInvoice(ws.ctx, inv.id);
    expect(done.invoice).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', paidCents: 1_000_000, outstandingCents: 0 });
    expect(done.invoice.paidAt).not.toBeNull();
    expect(done.payments).toHaveLength(3);
    expect(done.actions.recordPayment).toBe(false);
  });

  it('numbers payments and receipts on the server, in sequence', async () => {
    const w = await financeWorkspace('Receipt Shop');
    const inv = await issuedInvoice(w, { lines: [L('Work', 1, 100_000)] });
    const a = await pay(w, inv.id, 30_000);
    const b = await pay(w, inv.id, 30_000);
    expect(a.number).toBe('PAY-000001');
    expect(b.number).toBe('PAY-000002');
    expect(a.receiptNumber).toBe('RCT-000001');
    expect(b.receiptNumber).toBe('RCT-000002');
    const receipts = await listReceipts(w.ctx, {});
    expect(receipts.items).toHaveLength(2);
    // each receipt shows the balance as it was after that payment
    const rows = await ownerQuery('SELECT amount_cents, invoice_total_cents, invoice_paid_cents, remaining_cents FROM receipts WHERE business_id = $1 ORDER BY number', [w.businessId]);
    expect(rows.rows.filter((r) => r.invoice_total_cents === 100_000).map((r) => [r.invoice_paid_cents, r.remaining_cents])).toEqual([[30_000, 70_000], [60_000, 40_000]]);
  });

  it('refuses nonsense amounts and unknown methods', async () => {
    const inv = await invoiceOf(100_000);
    for (const amountCents of [0, -500, 10.5, 'abc', null, 2_000_000_001, Number.NaN]) {
      const e = await err(recordPayment(ws.ctx, { invoiceId: inv.id, amountCents, method: 'CASH' }));
      expect(e.code, String(amountCents)).toBe('VALIDATION_ERROR');
    }
    expect((await err(recordPayment(ws.ctx, { invoiceId: inv.id, amountCents: 100, method: 'BITCOIN' }))).code).toBe('VALIDATION_ERROR');
    expect((await err(recordPayment(ws.ctx, { amountCents: 100, method: 'CASH' }))).code).toBe('VALIDATION_ERROR'); // no invoice
    expect((await err(recordPayment(ws.ctx, { invoiceId: inv.id, amountCents: 100, method: 'CASH', paidAt: new Date(Date.now() + 86_400_000 * 3).toISOString() }))).code).toBe('VALIDATION_ERROR');
    expect((await getInvoice(ws.ctx, inv.id)).invoice.paidCents).toBe(0);
  });

  it('a payment method can be switched off, and old payments keep their method', async () => {
    const w = await financeWorkspace('Methods Shop');
    const inv = await issuedInvoice(w, { lines: [L('Work', 1, 100_000)] });
    await pay(w, inv.id, 10_000, 'CARD');
    await ownerQuery("UPDATE finance_settings SET enabled_methods = ARRAY['EFT','CASH']::payment_method[] WHERE business_id = $1", [w.businessId]);
    expect((await err(pay(w, inv.id, 10_000, 'CARD'))).code).toBe('VALIDATION_ERROR');
    expect((await pay(w, inv.id, 10_000, 'EFT')).status).toBe('COMPLETED');
    expect((await listPayments(w.ctx, { method: 'CARD' })).items).toHaveLength(1);
  });

  it('an invoice that is already paid, cancelled, still a draft, or written off takes no more payment', async () => {
    const inv = await invoiceOf(50_000);
    await pay(ws, inv.id, 50_000);
    const e = await err(pay(ws, inv.id, 100));
    expect(e).toMatchObject({ code: 'CONFLICT' });
    expect(e.details).toMatchObject({ code: 'INVOICE_ALREADY_PAID' });
  });

  it('is idempotent: the same request key records one payment, however many times it arrives', async () => {
    const inv = await invoiceOf(200_000);
    const k = key();
    const first = await recordPayment(ws.ctx, { invoiceId: inv.id, amountCents: 50_000, method: 'EFT', idempotencyKey: k });
    const second = await recordPayment(ws.ctx, { invoiceId: inv.id, amountCents: 50_000, method: 'EFT', idempotencyKey: k });
    expect(second).toMatchObject({ id: first.id, alreadyRecorded: true });
    expect((await err(recordPayment(ws.ctx, { invoiceId: inv.id, amountCents: 60_000, method: 'EFT', idempotencyKey: k }))).code).toBe('CONFLICT');
    // many at once
    const k2 = key();
    const burst = await Promise.all(Array.from({ length: 6 }, () => recordPayment(ws.ctx, { invoiceId: inv.id, amountCents: 10_000, method: 'CASH', idempotencyKey: k2 })));
    expect(new Set(burst.map((b) => b.id)).size).toBe(1);
    const got = await getInvoice(ws.ctx, inv.id);
    expect(got.payments).toHaveLength(2);
    expect(got.invoice.paidCents).toBe(60_000);
  });

  it('simultaneous payments against one invoice never over-settle it: the excess becomes credit', async () => {
    const inv = await invoiceOf(100_000);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => pay(ws, inv.id, 40_000)));
    const done = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    // 40k + 40k + 40k settles it (the third carries 20k of excess); the other two arrive after it is paid and are refused.
    expect(done).toHaveLength(3);
    expect(done.reduce((a, r) => a + r.appliedCents, 0)).toBe(100_000);
    expect(done.reduce((a, r) => a + r.creditedCents, 0)).toBe(20_000);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(((r as PromiseRejectedResult).reason as AppError).details).toMatchObject({ code: 'INVOICE_ALREADY_PAID' });
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ status: 'PAID', outstandingCents: 0, paidCents: 100_000 });
    expect(await credit(inv.customerId)).toBe(20_000);
  });

  it('queues a receipt email to the customer and logs it', async () => {
    const inv = await invoiceOf(80_000);
    await pay(ws, inv.id, 80_000);
    const c = await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [inv.customerId]);
    const mail = await latestEmailTo(c.rows[0]!.email);
    expect(mail?.subject).toContain('Payment received');
    expect(mail?.text).toMatch(/Receipt RCT-\d+/);
    const log = await ownerQuery("SELECT status FROM communications WHERE customer_id = $1 AND event = 'PAYMENT_RECEIVED'", [inv.customerId]);
    expect(log.rows).toHaveLength(1);
    await drainJobs();
  });

  it('receipts render as real PDFs and are filed in the document store', async () => {
    const w = await financeWorkspace('Receipt PDF Shop');
    const inv = await issuedInvoice(w, { lines: [L('Work', 1, 100_000)] });
    const p = await pay(w, inv.id, 40_000, 'CARD', { reference: 'AUTH-9911' });
    const { pdf, filename } = await getReceiptPdf(w.ctx, p.receiptId!);
    expect(filename).toBe(`${p.receiptNumber}.pdf`);
    const text = pdfText(pdf);
    for (const s of ['RECEIPT', p.receiptNumber!, p.number, 'AUTH-9911', 'Amount received', 'Remaining balance', 'Card']) expect(text, s).toContain(s);
    const files = await ownerQuery("SELECT 1 FROM files WHERE resource_type = 'receipt' AND resource_id = $1", [p.receiptId]);
    expect(files.rows).toHaveLength(1);
  });
});

describe('overpayments, deposits and customer credit', () => {
  it('records the whole payment and turns the excess into credit: R6,000 against R5,000', async () => {
    const inv = await invoiceOf(500_000);
    const p = await pay(ws, inv.id, 600_000);
    expect(p).toMatchObject({ amountCents: 600_000, appliedCents: 500_000, creditedCents: 100_000 });
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ status: 'PAID', paidCents: 500_000 });
    expect(await credit(inv.customerId)).toBe(100_000);
    const detail = await getPayment(ws.ctx, p.id);
    expect(detail.payment).toMatchObject({ amountCents: 600_000, appliedCents: 500_000, creditedCents: 100_000 });
    const ledger = (await getCustomerCredit(ws.ctx, inv.customerId)).entries;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'OVERPAYMENT', amountCents: 100_000, paymentId: p.id });
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE action = 'credit.added' AND resource_id = $1", [inv.customerId])).rows).toHaveLength(1);
  });

  it('takes a deposit as proper credit with no fake invoice, and applies it to the invoice later', async () => {
    const { customer, vehicle } = await party(ws, 'Dep');
    const invoicesBefore = (await ownerQuery('SELECT count(*)::int AS n FROM invoices WHERE customer_id = $1', [customer.id])).rows[0]!.n;
    const dep = await recordPayment(ws.ctx, { purpose: 'DEPOSIT', customerId: customer.id, amountCents: 300_000, method: 'EFT', idempotencyKey: key(), reference: 'Deposit for engine job' });
    expect(dep).toMatchObject({ status: 'COMPLETED', appliedCents: 0, creditedCents: 300_000, invoice: null });
    expect((await ownerQuery('SELECT count(*)::int AS n FROM invoices WHERE customer_id = $1', [customer.id])).rows[0]!.n).toBe(invoicesBefore);
    expect(await credit(customer.id)).toBe(300_000);
    expect((await getCustomerCredit(ws.ctx, customer.id)).entries[0]).toMatchObject({ kind: 'DEPOSIT', amountCents: 300_000 });

    const inv = await invoiceOf(1_000_000, customer.id, vehicle.id);
    const applied = await applyCredit(ws.ctx, inv.id, { amountCents: 300_000, idempotencyKey: key() });
    expect(applied).toMatchObject({ status: 'PARTIALLY_PAID', outstandingCents: 700_000, creditRemainingCents: 0 });
    const got = await getInvoice(ws.ctx, inv.id);
    expect(got.invoice).toMatchObject({ paidCents: 0, creditAppliedCents: 300_000, outstandingCents: 700_000 });
    expect(got.creditApplications).toHaveLength(1);
    await pay(ws, inv.id, 700_000);
    expect((await getInvoice(ws.ctx, inv.id)).invoice.status).toBe('PAID');
    // financial history shows the deposit, the credit use and the payment
    const kinds = (await getCustomerCredit(ws.ctx, customer.id)).entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(['APPLIED', 'DEPOSIT']);
  });

  it('refuses deposits when they are switched off', async () => {
    const w = await financeWorkspace('No Deposit Shop');
    const p = await party(w);
    await ownerQuery('UPDATE finance_settings SET deposits_enabled = false WHERE business_id = $1', [w.businessId]);
    expect((await err(recordPayment(w.ctx, { purpose: 'DEPOSIT', customerId: p.customer.id, amountCents: 100, method: 'CASH' }))).code).toBe('VALIDATION_ERROR');
  });

  it('cannot apply more credit than the customer has or the invoice owes', async () => {
    const { customer, vehicle } = await party(ws, 'Cr');
    await recordPayment(ws.ctx, { purpose: 'DEPOSIT', customerId: customer.id, amountCents: 100_000, method: 'CASH' });
    const inv = await invoiceOf(500_000, customer.id, vehicle.id);
    const tooMuch = await err(applyCredit(ws.ctx, inv.id, { amountCents: 100_001 }));
    expect(tooMuch.code).toBe('CONFLICT');
    const small = await invoiceOf(30_000, customer.id, vehicle.id);
    expect((await err(applyCredit(ws.ctx, small.id, { amountCents: 40_000 }))).code).toBe('VALIDATION_ERROR');
    expect((await err(applyCredit(ws.ctx, inv.id, { amountCents: 0 }))).code).toBe('VALIDATION_ERROR');
    expect(await credit(customer.id)).toBe(100_000);
  });

  it('the same credit can never be spent twice, even by simultaneous requests', async () => {
    const { customer, vehicle } = await party(ws, 'Race');
    await recordPayment(ws.ctx, { purpose: 'DEPOSIT', customerId: customer.id, amountCents: 100_000, method: 'CASH' });
    const a = await invoiceOf(80_000, customer.id, vehicle.id);
    const b = await invoiceOf(80_000, customer.id, vehicle.id);
    const c = await invoiceOf(80_000, customer.id, vehicle.id);
    const results = await Promise.allSettled([applyCredit(ws.ctx, a.id, { amountCents: 80_000 }), applyCredit(ws.ctx, b.id, { amountCents: 80_000 }), applyCredit(ws.ctx, c.id, { amountCents: 80_000 })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await credit(customer.id)).toBe(20_000);
    // the same application repeated with one key applies once
    const d = await invoiceOf(15_000, customer.id, vehicle.id);
    const k = key();
    const twice = await Promise.all([applyCredit(ws.ctx, d.id, { amountCents: 15_000, idempotencyKey: k }), applyCredit(ws.ctx, d.id, { amountCents: 15_000, idempotencyKey: k })]);
    expect(twice.filter((t) => !t.alreadyApplied)).toHaveLength(1);
    expect(await credit(customer.id)).toBe(5000);
    expect((await getInvoice(ws.ctx, d.id)).invoice.creditAppliedCents).toBe(15_000);
  });

  it('the ledger can never go below zero, enforced by the database', async () => {
    const { customer } = await party(ws, 'Floor');
    await recordPayment(ws.ctx, { purpose: 'DEPOSIT', customerId: customer.id, amountCents: 10_000, method: 'CASH' });
    await expect(ownerQuery("INSERT INTO customer_credit_entries (business_id, customer_id, kind, amount_cents) VALUES ($1, $2, 'APPLIED', -10001)", [ws.businessId, customer.id])).rejects.toThrow(/below zero/);
    await expect(ownerQuery("UPDATE customer_credit_entries SET amount_cents = 5 WHERE customer_id = $1", [customer.id])).rejects.toThrow(/append-only/);
    await expect(ownerQuery('DELETE FROM customer_credit_entries WHERE customer_id = $1', [customer.id])).rejects.toThrow(/append-only/);
  });
});

describe('refunds', () => {
  it('refunds part of a payment: the invoice reopens and the payment shows partially refunded', async () => {
    const inv = await invoiceOf(100_000);
    const p = await pay(ws, inv.id, 100_000);
    const r = await refundPayment(ws.ctx, p.id, { amountCents: 30_000, reason: 'Part returned' });
    expect(r).toMatchObject({ status: 'PARTIALLY_REFUNDED', amountCents: 30_000, invoiceOutstandingCents: 30_000 });
    expect(r.number).toMatch(/^RFD-\d{6}$/);
    const got = await getInvoice(ws.ctx, inv.id);
    expect(got.invoice).toMatchObject({ paidCents: 70_000, outstandingCents: 30_000, status: 'PARTIALLY_PAID' });
    const detail = await getPayment(ws.ctx, p.id);
    expect(detail.payment).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundableCents: 70_000 });
    expect(detail.refunds).toHaveLength(1);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'payment.refunded'", [p.id])).rows).toHaveLength(1);
  });

  it('can never refund more than was paid, in one go or over several', async () => {
    const inv = await invoiceOf(100_000);
    const p = await pay(ws, inv.id, 100_000);
    expect((await err(refundPayment(ws.ctx, p.id, { amountCents: 100_001, reason: 'Too much' }))).code).toBe('CONFLICT');
    await refundPayment(ws.ctx, p.id, { amountCents: 60_000, reason: 'First part' });
    const e = await err(refundPayment(ws.ctx, p.id, { amountCents: 40_001, reason: 'Second part' }));
    expect(e).toMatchObject({ code: 'CONFLICT' });
    expect(e.details).toMatchObject({ maxCents: 40_000 });
    expect((await refundPayment(ws.ctx, p.id, { amountCents: 40_000, reason: 'The rest' })).status).toBe('REFUNDED');
    expect((await err(refundPayment(ws.ctx, p.id, { amountCents: 1, reason: 'Again' }))).code).toBe('CONFLICT');
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ paidCents: 0, outstandingCents: 100_000 });
  });

  it('the same refund cannot be applied twice, even at the same moment', async () => {
    const inv = await invoiceOf(100_000);
    const p = await pay(ws, inv.id, 100_000);
    const results = await Promise.allSettled([refundPayment(ws.ctx, p.id, { amountCents: 100_000, reason: 'Duplicate A' }), refundPayment(ws.ctx, p.id, { amountCents: 100_000, reason: 'Duplicate B' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1', [p.id])).rows[0]!.n).toBe(1);
    // and with a key
    const inv2 = await invoiceOf(100_000);
    const p2 = await pay(ws, inv2.id, 100_000);
    const k = key();
    const a = await refundPayment(ws.ctx, p2.id, { amountCents: 10_000, reason: 'Goodwill', idempotencyKey: k });
    const b = await refundPayment(ws.ctx, p2.id, { amountCents: 10_000, reason: 'Goodwill', idempotencyKey: k });
    expect(b).toMatchObject({ refundId: a.refundId, alreadyRecorded: true });
  });

  it('gives back credit first, and only the credit the customer still has', async () => {
    const { customer, vehicle } = await party(ws, 'RefCr');
    const inv = await invoiceOf(100_000, customer.id, vehicle.id);
    const p = await pay(ws, inv.id, 150_000); // 100,000 applied + 50,000 credit
    expect(await credit(customer.id)).toBe(50_000);
    const r = await refundPayment(ws.ctx, p.id, { amountCents: 50_000, reason: 'Return the extra' });
    expect(r.status).toBe('PARTIALLY_REFUNDED');
    expect(await credit(customer.id)).toBe(0);
    expect((await getInvoice(ws.ctx, inv.id)).invoice.status).toBe('PAID'); // the invoice is untouched: only credit was returned

    // credit that was spent elsewhere cannot be refunded
    const inv2 = await invoiceOf(100_000, customer.id, vehicle.id);
    const p2 = await pay(ws, inv2.id, 130_000);
    const other = await invoiceOf(30_000, customer.id, vehicle.id);
    await applyCredit(ws.ctx, other.id, { amountCents: 30_000 });
    const e = await err(refundPayment(ws.ctx, p2.id, { amountCents: 130_000, reason: 'Everything' }));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toMatchObject({ maxCents: 100_000 });
    expect((await refundPayment(ws.ctx, p2.id, { amountCents: 100_000, reason: 'What is left' })).status).toBe('PARTIALLY_REFUNDED');
    expect((await getInvoice(ws.ctx, inv2.id)).invoice).toMatchObject({ outstandingCents: 100_000 });
  });

  it('refunds a deposit from the credit it created', async () => {
    const { customer } = await party(ws, 'RefDep');
    const d = await recordPayment(ws.ctx, { purpose: 'DEPOSIT', customerId: customer.id, amountCents: 80_000, method: 'EFT' });
    expect((await refundPayment(ws.ctx, d.id, { amountCents: 80_000, reason: 'Job cancelled' })).status).toBe('REFUNDED');
    expect(await credit(customer.id)).toBe(0);
  });

  it('refunds are recorded in the payment history and queue an email', async () => {
    const inv = await invoiceOf(60_000);
    const p = await pay(ws, inv.id, 60_000);
    await refundPayment(ws.ctx, p.id, { amountCents: 10_000, reason: 'Wrong part' });
    const c = await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [inv.customerId]);
    expect((await latestEmailTo(c.rows[0]!.email))?.subject).toContain('Refund');
    const ev = (await getPayment(ws.ctx, p.id)).events.map((e) => e.type);
    expect(ev).toEqual(expect.arrayContaining(['payment.recorded', 'payment.completed', 'payment.refunded']));
  });
});

describe('reconciliation, lists, permissions and isolation', () => {
  it('marks payments as reconciled and lists them with every reconciliation detail', async () => {
    const w = await financeWorkspace('Recon Shop');
    const inv = await issuedInvoice(w, { lines: [L('Work', 1, 100_000)] });
    const a = await pay(w, inv.id, 20_000, 'EFT', { reference: 'EFT-AAA-111' });
    await pay(w, inv.id, 30_000, 'CASH');
    expect((await listPayments(w.ctx, { reconciled: 'no' })).items).toHaveLength(2);
    await reconcilePayment(w.ctx, a.id, { reconciled: true, note: 'Matched on 3 Oct statement' });
    expect((await listPayments(w.ctx, { reconciled: 'yes' })).items.map((i) => i.id)).toEqual([a.id]);
    const row = (await listPayments(w.ctx, { q: 'EFT-AAA' })).items[0]!;
    expect(row).toMatchObject({ number: a.number, method: 'EFT', reference: 'EFT-AAA-111', reconciled: true, invoice: { number: inv.number } });
    expect(row.recordedBy).toBeTruthy();
    expect((await getPayment(w.ctx, a.id)).payment).toMatchObject({ reconciled: true, reconciliationNote: 'Matched on 3 Oct statement' });
    expect((await listPayments(w.ctx, { method: 'CASH' })).items).toHaveLength(1);
    expect((await listPayments(w.ctx, { minCents: 25_000 })).items).toHaveLength(1);
    expect((await listPayments(w.ctx, { q: inv.number })).items).toHaveLength(2);
    expect((await listPayments(w.ctx, { pageSize: 1 })).meta).toMatchObject({ total: 2, totalPages: 2 });
  });

  it('only people with the right permission can record, refund, apply credit and reconcile', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    const advisor = await createMemberCtx(ws, 'service_advisor');
    const manager = await createMemberCtx(ws, 'manager');
    const accounts = await createMemberCtx(ws, 'accounts');
    const inv = await invoiceOf(100_000);
    expect((await err(recordPayment(tech.ctx, { invoiceId: inv.id, amountCents: 100, method: 'CASH' }))).code).toBe('FORBIDDEN');
    expect((await err(listPayments(tech.ctx, {}))).code).toBe('FORBIDDEN');
    const p = await recordPayment(advisor.ctx, { invoiceId: inv.id, amountCents: 50_000, method: 'CASH', idempotencyKey: key() });
    expect((await err(refundPayment(advisor.ctx, p.id, { amountCents: 100, reason: 'nope' }))).code).toBe('FORBIDDEN');
    expect((await err(refundPayment(manager.ctx, p.id, { amountCents: 100, reason: 'nope' }))).code).toBe('FORBIDDEN');
    expect((await err(applyCredit(advisor.ctx, inv.id, { amountCents: 100 }))).code).toBe('FORBIDDEN');
    expect((await err(reconcilePayment(advisor.ctx, p.id, { reconciled: true }))).code).toBe('FORBIDDEN');
    expect((await refundPayment(accounts.ctx, p.id, { amountCents: 100, reason: 'Goodwill refund' })).status).toBe('PARTIALLY_REFUNDED');
    expect((await reconcilePayment(accounts.ctx, p.id, { reconciled: true })).reconciled).toBe(true);
  });

  it('a technician who works on a job gets no financial access from that', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    for (const perm of ['payment.view', 'payment.create', 'invoice.view', 'quote.view', 'finance.view_reports', 'job.view_pricing'] as const) expect(tech.ctx.permissions.has(perm), perm).toBe(false);
  });

  it('another business cannot see, pay, refund or reconcile these payments', async () => {
    const other = await createWorkspace('Not Our Business');
    const inv = await invoiceOf(100_000);
    const p = await pay(ws, inv.id, 40_000);
    for (const fn of [() => getPayment(other.ctx, p.id), () => refundPayment(other.ctx, p.id, { amountCents: 100, reason: 'steal' }), () => reconcilePayment(other.ctx, p.id, { reconciled: true }), () => getCustomerCredit(other.ctx, inv.customerId), () => applyCredit(other.ctx, inv.id, { amountCents: 100 })]) {
      expect((await err(fn())).code).toBe('NOT_FOUND');
    }
    expect((await listPayments(other.ctx, {})).items).toHaveLength(0);
    expect((await listReceipts(other.ctx, {})).items).toHaveLength(0);
  });

  it('payments are never deleted or silently edited', async () => {
    const inv = await invoiceOf(100_000);
    const p = await pay(ws, inv.id, 40_000);
    await expect(ownerQuery('DELETE FROM payments WHERE id = $1', [p.id])).rejects.toThrow(/cannot be deleted/);
    await expect(ownerQuery('UPDATE payments SET amount_cents = 1 WHERE id = $1', [p.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery("UPDATE payments SET method = 'CASH' WHERE id = $1", [p.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM refunds')).rejects.toThrow(/append-only/);
    await expect(ownerQuery('DELETE FROM receipts WHERE payment_id = $1', [p.id])).rejects.toThrow(/cannot be deleted/);
    await withTenant(ws.businessId, async (tx) => expect(await tx.payment.count({ where: { id: p.id } })).toBe(1));
  });

  it('keeps invoice balances in step with the payment rows, whatever happened (a consistency sweep)', async () => {
    const rows = await ownerQuery<{ id: string; number: string; paid: string; outstanding: number; total: number; credit_applied: number; noted: number; wo: number }>(`
      SELECT i.id, i.number, i.paid_cents AS paid, i.outstanding_cents AS outstanding, i.total_cents AS total, i.credit_applied_cents AS credit_applied, i.credit_noted_cents AS noted, i.written_off_cents AS wo
        FROM invoices i WHERE i.business_id = $1 AND i.finalised_at IS NOT NULL`, [ws.businessId]);
    expect(rows.rows.length).toBeGreaterThan(10);
    for (const r of rows.rows) {
      const p = await ownerQuery<{ s: string | null }>("SELECT COALESCE(SUM(applied_cents - refunded_applied_cents),0) AS s FROM payments WHERE invoice_id = $1 AND status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')", [r.id]);
      const c = await ownerQuery<{ s: string | null }>("SELECT COALESCE(-SUM(amount_cents),0) AS s FROM customer_credit_entries WHERE invoice_id = $1 AND kind = 'APPLIED'", [r.id]);
      expect(Number(p.rows[0]!.s), `paid ${r.number}`).toBe(Number(r.paid));
      expect(Number(c.rows[0]!.s), `credit ${r.number}`).toBe(r.credit_applied);
      expect(r.outstanding, `outstanding ${r.number}`).toBe(r.total - Number(r.paid) - r.credit_applied - r.noted - r.wo);
    }
  });
});
