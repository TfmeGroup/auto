import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { cancelInvoice, getInvoice } from '@/server/finance/invoices';
import { cancelCreditNote, createCreditNote, getCreditNote, issueCreditNote, listCreditNotes } from '@/server/finance/creditnotes';
import { getCreditNotePdf } from '@/server/finance/pdfs';
import { getCustomerCredit, recordPayment } from '@/server/finance/payments';
import { createMemberCtx, createWorkspace, latestEmailTo, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice, party, pay, pdfText } from '../helpers/finance';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await financeWorkspace('Credit Note Shop');
});

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};
const credit = async (customerId: string) => (await getCustomerCredit(ws.ctx, customerId)).balanceCents;
const invoiceOf = (amount: number) => issuedInvoice(ws, { lines: [L('Work', 1, amount)] });

describe('credit notes', () => {
  it('a draft changes nothing until it is issued; issuing reduces what the customer owes', async () => {
    const inv = await invoiceOf(100_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Part was returned', lines: [L('Returned part', 1, 30_000)] });
    expect(cn.totalCents).toBe(30_000);
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ outstandingCents: 100_000, creditNotedCents: 0 });
    const issued = await issueCreditNote(ws.ctx, cn.id);
    expect(issued).toMatchObject({ appliedCents: 30_000, creditedCents: 0, already: false });
    expect(issued.number).toMatch(/^CN-\d{6}$/);
    const got = await getInvoice(ws.ctx, inv.id);
    expect(got.invoice).toMatchObject({ outstandingCents: 70_000, creditNotedCents: 30_000, paidCents: 0, status: 'ISSUED', paymentStatus: 'UNPAID', totalCents: 100_000 });
    expect(got.creditNotes).toHaveLength(1);
    // the original invoice and its lines are exactly as they were
    expect(got.lines).toHaveLength(1);
    expect(got.lines[0]).toMatchObject({ unitPriceCents: 100_000 });
    await pay(ws, inv.id, 70_000);
    expect((await getInvoice(ws.ctx, inv.id)).invoice.status).toBe('PAID');
  });

  it('issuing twice is harmless', async () => {
    const inv = await invoiceOf(50_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Goodwill', lines: [L('Goodwill', 1, 10_000)] });
    const a = await issueCreditNote(ws.ctx, cn.id);
    const [b, c] = await Promise.all([issueCreditNote(ws.ctx, cn.id), issueCreditNote(ws.ctx, cn.id)]);
    expect(b.number).toBe(a.number);
    expect(c.number).toBe(a.number);
    expect((await getInvoice(ws.ctx, inv.id)).invoice.outstandingCents).toBe(40_000);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND action = 'credit_note.issued'", [cn.id])).rows[0]!.n).toBe(1);
  });

  it('credit beyond what the invoice still owes becomes customer credit', async () => {
    const inv = await invoiceOf(100_000);
    await pay(ws, inv.id, 80_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Wrong labour charged', lines: [L('Labour reversal', 1, 50_000)] });
    const issued = await issueCreditNote(ws.ctx, cn.id);
    expect(issued).toMatchObject({ appliedCents: 20_000, creditedCents: 30_000 });
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ outstandingCents: 0, status: 'PAID', creditNotedCents: 20_000, paidCents: 80_000 });
    expect(await credit(inv.customerId)).toBe(30_000);
    expect((await getCustomerCredit(ws.ctx, inv.customerId)).entries[0]).toMatchObject({ kind: 'CREDIT_NOTE', amountCents: 30_000, creditNoteId: cn.id });
  });

  it('crediting a fully paid invoice puts all of it on the customer account', async () => {
    const inv = await invoiceOf(100_000);
    await pay(ws, inv.id, 100_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Job redone elsewhere', copy: 'full' });
    expect(cn.totalCents).toBe(100_000);
    expect(await issueCreditNote(ws.ctx, cn.id)).toMatchObject({ appliedCents: 0, creditedCents: 100_000 });
    expect(await credit(inv.customerId)).toBe(100_000);
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ status: 'PAID', paidCents: 100_000 });
  });

  it('a full credit note on a VAT invoice reverses it to the cent, VAT included', async () => {
    const w = await financeWorkspace('VAT Credit Shop', { vat: true });
    const inv = await issuedInvoice(w, { lines: [L('Part A', 3, 33_333, { discountType: 'PERCENT', discountValue: 750 }), L('Labour', 1.25, 45_000, { lineType: 'LABOUR' })] });
    const before = await getInvoice(w.ctx, inv.id);
    const cn = await createCreditNote(w.ctx, { invoiceId: inv.id, reason: 'Full reversal', copy: 'full' });
    const got = await getCreditNote(w.ctx, cn.id);
    expect(got.creditNote).toMatchObject({ totalCents: before.invoice.totalCents, vatCents: before.invoice.vatCents, subtotalCents: before.invoice.subtotalCents });
    await issueCreditNote(w.ctx, cn.id);
    expect((await getInvoice(w.ctx, inv.id)).invoice.outstandingCents).toBe(0);
  });

  it('credit notes can never add up to more than the invoice (drafts count too)', async () => {
    const inv = await invoiceOf(100_000);
    const a = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'First', lines: [L('x', 1, 60_000)] });
    const e = await err(createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Second', lines: [L('y', 1, 40_001)] }));
    expect(e).toMatchObject({ code: 'CONFLICT' });
    expect(e.details).toMatchObject({ maxCents: 40_000 });
    const b = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Second', lines: [L('y', 1, 40_000)] });
    await issueCreditNote(ws.ctx, a.id);
    await issueCreditNote(ws.ctx, b.id);
    expect((await getInvoice(ws.ctx, inv.id)).invoice.outstandingCents).toBe(0);
    expect((await err(createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Third', lines: [L('z', 1, 1)] }))).code).toBe('CONFLICT');
  });

  it('only issued invoices can be credited; a cancelled draft credit note does nothing', async () => {
    const { customer } = await party(ws);
    const { createInvoice } = await import('@/server/finance/invoices');
    const draft = await createInvoice(ws.ctx, { customerId: customer.id, lines: [L('x', 1, 100)] });
    expect((await err(createCreditNote(ws.ctx, { invoiceId: draft.id, reason: 'Nope', lines: [L('x', 1, 50)] }))).code).toBe('CONFLICT');
    const inv = await invoiceOf(10_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Changed my mind', lines: [L('x', 1, 5000)] });
    await cancelCreditNote(ws.ctx, cn.id, { reason: 'Not needed' });
    expect((await err(issueCreditNote(ws.ctx, cn.id))).code).toBe('CONFLICT');
    expect((await getCreditNote(ws.ctx, cn.id)).creditNote.status).toBe('CANCELLED');
    const inv2 = await invoiceOf(10_000);
    const cn2 = await createCreditNote(ws.ctx, { invoiceId: inv2.id, reason: 'Real', lines: [L('x', 1, 5000)] });
    await issueCreditNote(ws.ctx, cn2.id);
    expect((await err(cancelCreditNote(ws.ctx, cn2.id))).code).toBe('CONFLICT'); // issued is final
    await cancelInvoice(ws.ctx, inv.id, { reason: 'Void' });
    expect((await err(createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Late', lines: [L('x', 1, 1)] }))).code).toBe('CONFLICT');
  });

  it('an invoice with an issued credit note cannot be cancelled to hide it', async () => {
    const inv = await invoiceOf(10_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Real', lines: [L('x', 1, 1000)] });
    await issueCreditNote(ws.ctx, cn.id);
    expect((await err(cancelInvoice(ws.ctx, inv.id, { reason: 'Hide it' }))).code).toBe('CONFLICT');
  });

  it('is locked once issued, at the database level', async () => {
    const inv = await invoiceOf(10_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Real', lines: [L('x', 1, 1000)] });
    await issueCreditNote(ws.ctx, cn.id);
    await expect(ownerQuery('UPDATE credit_notes SET total_cents = 1 WHERE id = $1', [cn.id])).rejects.toThrow();
    await expect(ownerQuery('UPDATE credit_note_lines SET unit_price_cents = 1 WHERE credit_note_id = $1', [cn.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('DELETE FROM credit_notes WHERE id = $1', [cn.id])).rejects.toThrow(/cannot be deleted/);
  });

  it('separates who may raise a credit note from who may authorise it', async () => {
    const manager = await createMemberCtx(ws, 'manager'); // can create, cannot authorise
    const advisor = await createMemberCtx(ws, 'service_advisor');
    const accounts = await createMemberCtx(ws, 'accounts');
    const inv = await invoiceOf(10_000);
    expect((await err(createCreditNote(advisor.ctx, { invoiceId: inv.id, reason: 'Nope', lines: [L('x', 1, 1)] }))).code).toBe('FORBIDDEN');
    const cn = await createCreditNote(manager.ctx, { invoiceId: inv.id, reason: 'Raised by manager', lines: [L('x', 1, 1000)] });
    expect((await err(issueCreditNote(manager.ctx, cn.id))).code).toBe('FORBIDDEN');
    expect((await issueCreditNote(accounts.ctx, cn.id)).already).toBe(false);
    const detail = await getCreditNote(ws.ctx, cn.id);
    expect(detail.creditNote.createdBy).toBeTruthy();
    expect(detail.creditNote.authorisedBy).toBeTruthy();
    expect(detail.creditNote.createdBy).not.toBe(detail.creditNote.authorisedBy);
  });

  it('renders a PDF, emails the customer, lists and isolates', async () => {
    const inv = await invoiceOf(25_000);
    const cn = await createCreditNote(ws.ctx, { invoiceId: inv.id, reason: 'Wrong part supplied', lines: [L('Wrong part', 1, 25_000)] });
    const issued = await issueCreditNote(ws.ctx, cn.id);
    const { pdf } = await getCreditNotePdf(ws.ctx, cn.id);
    const text = pdfText(pdf);
    for (const s of ['CREDIT NOTE', issued.number, inv.number, 'Wrong part supplied']) expect(text, s).toContain(s);
    expect((await ownerQuery("SELECT 1 FROM files WHERE resource_type = 'credit_note' AND resource_id = $1", [cn.id])).rows).toHaveLength(1);
    const c = await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [inv.customerId]);
    expect((await latestEmailTo(c.rows[0]!.email))?.subject).toContain('Credit note');
    expect((await listCreditNotes(ws.ctx, { q: issued.number })).items.map((i) => i.id)).toEqual([cn.id]);
    expect((await listCreditNotes(ws.ctx, { status: 'ISSUED', invoiceId: inv.id })).items).toHaveLength(1);
    const other = await createWorkspace('Credit Note Spy');
    expect((await err(getCreditNote(other.ctx, cn.id))).code).toBe('NOT_FOUND');
    expect((await err(issueCreditNote(other.ctx, cn.id))).code).toBe('NOT_FOUND');
    expect((await err(getCreditNotePdf(other.ctx, cn.id))).code).toBe('NOT_FOUND');
    expect((await listCreditNotes(other.ctx, {})).items).toHaveLength(0);
    void recordPayment;
  });
});
