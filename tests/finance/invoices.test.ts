import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { createJob } from '@/server/jobcards/service';
import { addJobLabour, addJobPart } from '@/server/jobcards/items';
import { cancelInvoice, createInvoice, createInvoiceFromJob, finaliseInvoice, getInvoice, listInvoices, sendInvoice, updateInvoice, writeOffInvoice } from '@/server/finance/invoices';
import { getPublicInvoice } from '@/server/finance/online';
import { getInvoicePdf } from '@/server/finance/pdfs';
import { setLabourCostRate } from '@/server/finance/settings';
import { recordPayment } from '@/server/finance/payments';
import { runFinanceTasks } from '@/server/finance/scheduled';
import { createMemberCtx, createWorkspace, ownerQuery, testMeta, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice, key, party, pay, pdfText, setVat, tokenOf } from '../helpers/finance';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await financeWorkspace('Invoice Workshop');
});

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

describe('drafts and finalising', () => {
  it('a draft has no number, is editable, and totals are calculated by the server', async () => {
    const { customer } = await party(ws);
    const d = await createInvoice(ws.ctx, { customerId: customer.id, lines: [L('Pads', 2, 50_000)], totalCents: 1 });
    let inv = await getInvoice(ws.ctx, d.id);
    expect(inv.invoice).toMatchObject({ status: 'DRAFT', paymentStatus: 'DRAFT', number: null, totalCents: 100_000, outstandingCents: 100_000 });
    expect(inv.actions).toMatchObject({ edit: true, finalise: true, recordPayment: false });
    await updateInvoice(ws.ctx, d.id, { lines: [L('Pads', 3, 50_000)], title: 'Brake job' });
    inv = await getInvoice(ws.ctx, d.id);
    expect(inv.invoice.totalCents).toBe(150_000);
    expect(inv.invoice.title).toBe('Brake job');
  });

  it('issuing allocates the number, dates and a frozen snapshot, and cannot be repeated', async () => {
    const { customer } = await party(ws);
    const d = await createInvoice(ws.ctx, { customerId: customer.id, lines: [L('Pads', 1, 100_000)], customerNotes: 'Thank you' });
    const r = await finaliseInvoice(ws.ctx, d.id);
    expect(r.number).toMatch(/^INV-\d{6}$/);
    const inv = await getInvoice(ws.ctx, d.id);
    expect(inv.invoice).toMatchObject({ number: r.number, status: 'ISSUED', paymentStatus: 'UNPAID', outstandingCents: 100_000, hasSnapshot: true });
    expect(inv.invoice.dueDate! > inv.invoice.invoiceDate!).toBe(true);
    const again = await finaliseInvoice(ws.ctx, d.id);
    expect(again).toMatchObject({ number: r.number, already: true });
    expect((await ownerQuery('SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = $2', [d.id, 'invoice.finalised'])).rows).toHaveLength(1);
  });

  it('refuses to issue an empty invoice', async () => {
    const { customer } = await party(ws);
    const d = await createInvoice(ws.ctx, { customerId: customer.id });
    expect((await err(finaliseInvoice(ws.ctx, d.id))).code).toBe('VALIDATION_ERROR');
  });

  it('numbers issued invoices without gaps or repeats, even when many are issued at once', async () => {
    const w = await financeWorkspace('Numbering Shop');
    const drafts = await Promise.all(Array.from({ length: 8 }, async () => {
      const { customer } = await party(w);
      return createInvoice(w.ctx, { customerId: customer.id, lines: [L('Item', 1, 10_000)] });
    }));
    const issued = await Promise.all(drafts.map((d) => finaliseInvoice(w.ctx, d.id)));
    const nums = issued.map((i) => Number(i.number.slice(4))).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(8);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('numbers keep working when the format is changed; issued numbers never change', async () => {
    const w = await financeWorkspace('Format Shop');
    const a = await issuedInvoice(w);
    await ownerQuery("UPDATE finance_settings SET invoice_prefix = 'TAX', number_padding = 4 WHERE business_id = $1", [w.businessId]);
    const b = await issuedInvoice(w);
    expect(a.number).toBe('INV-000001');
    expect(b.number).toBe('TAX-0002');
    expect((await getInvoice(w.ctx, a.id)).invoice.number).toBe('INV-000001');
  });

  it('a location code goes into that location\'s numbers, with its own counter', async () => {
    const w = await financeWorkspace('Branch Shop');
    const loc = await ownerQuery<{ id: string }>('SELECT id FROM locations WHERE business_id = $1 LIMIT 1', [w.businessId]);
    await ownerQuery("UPDATE locations SET doc_code = 'CPT' WHERE id = $1", [loc.rows[0]!.id]);
    const a = await issuedInvoice(w);
    const b = await issuedInvoice(w);
    expect(a.number).toBe('INV-CPT-000001');
    expect(b.number).toBe('INV-CPT-000002');
  });
});

describe('issued invoices are locked', () => {
  it('cannot be edited through the service', async () => {
    const inv = await issuedInvoice(ws);
    expect((await err(updateInvoice(ws.ctx, inv.id, { lines: [L('Sneaky', 1, 1)] }))).code).toBe('CONFLICT');
    expect((await err(updateInvoice(ws.ctx, inv.id, { title: 'new title' }))).code).toBe('CONFLICT');
    // a private note is the one thing that can still change
    await updateInvoice(ws.ctx, inv.id, { internalNotes: 'Chased on Friday' });
    expect((await getInvoice(ws.ctx, inv.id)).invoice.internalNotes).toBe('Chased on Friday');
  });

  it('cannot be altered at the database level either: numbers, parties, totals, lines', async () => {
    const inv = await issuedInvoice(ws);
    await expect(ownerQuery('UPDATE invoices SET total_cents = 1, outstanding_cents = 1 WHERE id = $1', [inv.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery("UPDATE invoices SET number = 'INV-999999' WHERE id = $1", [inv.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('UPDATE invoices SET customer_id = (SELECT id FROM customers WHERE id <> customer_id LIMIT 1) WHERE id = $1', [inv.id])).rejects.toThrow();
    await expect(ownerQuery('UPDATE invoice_lines SET unit_price_cents = 1 WHERE invoice_id = $1', [inv.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('DELETE FROM invoice_lines WHERE invoice_id = $1', [inv.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('DELETE FROM invoices WHERE id = $1', [inv.id])).rejects.toThrow(/cannot be deleted/);
    // and the app role (the one the running application uses) is refused just the same
    await expect(withTenant(ws.businessId, (tx) => tx.invoiceLine.updateMany({ where: { invoiceId: inv.id }, data: { unitPriceCents: 1 } }))).rejects.toThrow();
  });

  it('keeps its history when business settings, customer details and prices change later', async () => {
    const w = await financeWorkspace('History Shop', { vat: true });
    const { customer } = await party(w);
    const inv = await issuedInvoice(w, { customerId: customer.id, lines: [L('Clutch kit', 1, 100_000, { unitCostCents: 60_000 })] });
    const before = await getInvoice(w.ctx, inv.id);
    expect(before.invoice).toMatchObject({ totalCents: 115_000, vatCents: 15_000, vatRateBps: 1500 });
    const pdfBefore = pdfText((await getInvoicePdf(w.ctx, inv.id)).pdf);
    expect(pdfBefore).toContain('TAX INVOICE');
    await setVat(w, false);
    await ownerQuery('UPDATE businesses SET name = $2, vat_rate_bps = 1000 WHERE id = $1', [w.businessId, 'Renamed Workshop']);
    await ownerQuery("UPDATE customers SET name = 'Totally Different Name' WHERE id = $1", [customer.id]);
    const after = await getInvoice(w.ctx, inv.id);
    expect(after.invoice).toMatchObject({ totalCents: 115_000, vatCents: 15_000, vatRateBps: 1500, vatRegistered: true });
    const pdfAfter = pdfText((await getInvoicePdf(w.ctx, inv.id)).pdf);
    expect(pdfAfter).toContain('TAX INVOICE');
    expect(pdfAfter).toContain('History Shop');
    expect(pdfAfter).not.toContain('Renamed Workshop');
    expect(pdfAfter).not.toContain('Totally Different');
  });
});

describe('cancelling and writing off', () => {
  it('cancels a draft; an unpaid issued invoice can be cancelled but keeps its number; numbers are not reused', async () => {
    const w = await financeWorkspace('Cancel Shop');
    const a = await issuedInvoice(w);
    await cancelInvoice(w.ctx, a.id, { reason: 'Issued to the wrong customer' });
    const got = await getInvoice(w.ctx, a.id);
    expect(got.invoice).toMatchObject({ status: 'CANCELLED', paymentStatus: 'CANCELLED', number: a.number, cancelReason: 'Issued to the wrong customer' });
    const b = await issuedInvoice(w);
    expect(b.number).not.toBe(a.number);
    const { customer } = await party(w);
    const draft = await createInvoice(w.ctx, { customerId: customer.id, lines: [L('x', 1, 100)] });
    expect((await cancelInvoice(w.ctx, draft.id, { reason: 'Not needed' })).status).toBe('CANCELLED');
    expect((await err(finaliseInvoice(w.ctx, draft.id))).code).toBe('CONFLICT');
  });

  it('an invoice with money against it cannot be cancelled or deleted', async () => {
    const inv = await issuedInvoice(ws);
    await pay(ws, inv.id, 1000);
    expect((await err(cancelInvoice(ws.ctx, inv.id, { reason: 'Mistake' }))).code).toBe('CONFLICT');
    expect((await getInvoice(ws.ctx, inv.id)).actions.cancel).toBe(false);
  });

  it('writing off keeps the history and closes the balance; nothing can then be paid', async () => {
    const inv = await issuedInvoice(ws);
    await pay(ws, inv.id, 40_000);
    const r = await writeOffInvoice(ws.ctx, inv.id, { reason: 'Customer cannot be traced' });
    expect(r).toMatchObject({ status: 'WRITTEN_OFF', writtenOffCents: 100_000 + 45_000 - 40_000 });
    const got = await getInvoice(ws.ctx, inv.id);
    expect(got.invoice).toMatchObject({ status: 'WRITTEN_OFF', paymentStatus: 'WRITTEN_OFF', outstandingCents: 0, paidCents: 40_000 });
    expect((await err(pay(ws, inv.id, 100))).code).toBe('CONFLICT');
    expect((await writeOffInvoice(ws.ctx, inv.id, { reason: 'Again' })).status).toBe('WRITTEN_OFF'); // repeating it changes nothing
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'invoice.written_off'", [inv.id])).rows).toHaveLength(1);
    const paid = await issuedInvoice(ws);
    await pay(ws, paid.id, 145_000);
    expect((await err(writeOffInvoice(ws.ctx, paid.id, { reason: 'Nothing owed' }))).code).toBe('CONFLICT');
  });
});

describe('invoice from a job', () => {
  async function completedJob(w: TestWorkspace) {
    const { customer, vehicle } = await party(w, 'JobInv');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Service' });
    return { customer, vehicle, job };
  }

  it('bills only what was actually used: fitted parts and recorded labour, with costs snapshotted', async () => {
    const w = await financeWorkspace('Job Invoice Shop', { vat: true });
    const tech = await createMemberCtx(w, 'technician');
    await setLabourCostRate(w.ctx, tech.ctx.membership.id, { labourCostCentsPerHour: 20_000 });
    const { customer, job } = await completedJob(w);
    await addJobPart(w.ctx, job.id, { description: 'Oil filter', partNumber: 'OF-1', quantity: 1, status: 'FITTED', costCents: 4000, sellPriceCents: 9500 });
    await addJobPart(w.ctx, job.id, { description: 'Spark plugs', quantity: 4, status: 'FITTED', costCents: 3000, sellPriceCents: 6000 });
    await addJobPart(w.ctx, job.id, { description: 'Reserved but never used', quantity: 1, status: 'RESERVED', costCents: 100, sellPriceCents: 50_000 });
    await addJobPart(w.ctx, job.id, { description: 'Only requested', quantity: 1, status: 'REQUESTED', sellPriceCents: 40_000 });
    await addJobPart(w.ctx, job.id, { description: 'Returned part', quantity: 1, status: 'RETURNED', sellPriceCents: 30_000 });
    await addJobLabour(w.ctx, job.id, { description: 'Service labour', minutes: 90, technicianMembershipId: tech.ctx.membership.id, rateCentsPerHour: 45_000 });
    expect((await err(createInvoiceFromJob(w.ctx, job.id))).code).toBe('CONFLICT'); // job not finished yet
    await ownerQuery("UPDATE job_cards SET status = 'COMPLETED' WHERE id = $1", [job.id]);

    const r = await createInvoiceFromJob(w.ctx, job.id);
    const inv = await getInvoice(w.ctx, r.id);
    const names = inv.lines.map((l) => l.description);
    expect(names).toEqual(expect.arrayContaining(['Oil filter', 'Spark plugs']));
    expect(names.some((n) => n.startsWith('Service labour'))).toBe(true);
    expect(names).not.toContain('Reserved but never used');
    expect(names).not.toContain('Only requested');
    expect(names).not.toContain('Returned part');
    expect(r.warnings.some((x) => x.includes('not fitted'))).toBe(true);
    // 9500 + 4 x 6000 + 90 min @ R450/h (= R675) = 9500 + 24000 + 67500 = 101000, + 15% VAT
    expect(inv.invoice).toMatchObject({ jobId: job.id, customerId: customer.id, status: 'DRAFT', subtotalCents: 101_000, vatCents: 15_150, totalCents: 116_150 });
    const labour = inv.lines.find((l) => l.lineType === 'LABOUR')!;
    expect(labour).toMatchObject({ minutes: 90, unitPriceCents: 67_500, unitCostCents: 30_000 }); // 90 min x R200/h cost
    expect(inv.lines.find((l) => l.description === 'Spark plugs')).toMatchObject({ quantityMilli: 4000, unitCostCents: 3000 });
    expect(inv.profit).toMatchObject({ revenueCents: 101_000, costCents: 4000 + 12_000 + 30_000 });

    // later catalogue / rate changes do not rewrite the invoice
    await ownerQuery("UPDATE job_parts SET sell_price_cents = 1, cost_cents = 1 WHERE job_id = $1", [job.id]);
    await ownerQuery('UPDATE job_labour SET rate_cents_per_hour = 1, total_cents = 1 WHERE job_id = $1', [job.id]);
    await setLabourCostRate(w.ctx, tech.ctx.membership.id, { labourCostCentsPerHour: 99_999 });
    expect((await getInvoice(w.ctx, r.id)).invoice.totalCents).toBe(116_150);
    expect((await getInvoice(w.ctx, r.id)).lines.find((l) => l.lineType === 'LABOUR')!.unitCostCents).toBe(30_000);

    // one invoice per job
    expect((await err(createInvoiceFromJob(w.ctx, job.id))).code).toBe('CONFLICT');
    await cancelInvoice(w.ctx, r.id, { reason: 'Redo' });
    expect((await createInvoiceFromJob(w.ctx, job.id)).id).not.toBe(r.id);
  });

  it('refuses when nothing billable has been recorded and when two people invoice at once', async () => {
    const { job } = await completedJob(ws);
    await ownerQuery("UPDATE job_cards SET status = 'READY_FOR_COLLECTION' WHERE id = $1", [job.id]);
    expect((await err(createInvoiceFromJob(ws.ctx, job.id))).code).toBe('VALIDATION_ERROR');
    await addJobPart(ws.ctx, job.id, { description: 'Bulb', quantity: 1, status: 'FITTED', sellPriceCents: 5000 });
    const res = await Promise.allSettled([createInvoiceFromJob(ws.ctx, job.id), createInvoiceFromJob(ws.ctx, job.id)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM invoices WHERE job_id = $1 AND status <> 'CANCELLED'", [job.id])).rows[0]!.n).toBe(1);
  });
});

describe('sending and the customer view', () => {
  it('shows the customer only what is meant for them, never internal notes or costs', async () => {
    const inv = await issuedInvoice(ws, { send: true, internalNotes: 'INTERNAL: chase finance', lines: [L('Gearbox', 1, 300_000, { unitCostCents: 180_000 })], terms: 'Pay within 14 days' });
    const view = await getPublicInvoice(tokenOf(inv.customerUrl!), testMeta());
    expect(view.invoice).toMatchObject({ number: inv.number, status: 'VIEWED', paymentStatus: 'UNPAID', terms: 'Pay within 14 days' });
    expect(view.totals).toMatchObject({ totalCents: 300_000, outstandingCents: 300_000, paidCents: 0 });
    const json = JSON.stringify(view);
    expect(json).not.toContain('INTERNAL');
    expect(json).not.toContain('180000');
    expect(json).not.toContain('unitCost');
    expect(json).not.toContain('internalNotes');
    expect((await getInvoice(ws.ctx, inv.id)).invoice.status).toBe('VIEWED');
  });

  it('shows how to pay by EFT when online payment is not set up, and the balance after payments', async () => {
    await ownerQuery("UPDATE finance_settings SET payment_instructions = 'FNB 62000000000, ref: invoice number' WHERE business_id = $1", [ws.businessId]);
    const inv = await issuedInvoice(ws, { send: true });
    await pay(ws, inv.id, 50_000);
    const view = await getPublicInvoice(tokenOf(inv.customerUrl!), testMeta());
    expect(view.payment.instructions).toContain('FNB 62000000000');
    expect(view.payment.online).toBeNull();
    expect(view.totals).toMatchObject({ paidCents: 50_000, outstandingCents: 95_000 });
    expect(view.invoice.status).toBe('PARTIALLY_PAID');
    await pay(ws, inv.id, 95_000);
    const paid = await getPublicInvoice(tokenOf(inv.customerUrl!), testMeta());
    expect(paid.invoice.status).toBe('PAID');
    expect(paid.payment.instructions).toBeNull();
  });

  it('a draft invoice cannot be sent', async () => {
    const { customer } = await party(ws);
    const d = await createInvoice(ws.ctx, { customerId: customer.id, lines: [L('x', 1, 100)] });
    expect((await err(sendInvoice(ws.ctx, d.id))).code).toBe('CONFLICT');
  });
});

describe('PDF', () => {
  it('renders a real PDF from the stored data, with the details a tax invoice needs', async () => {
    const w = await financeWorkspace('PDF Shop', { vat: true });
    await ownerQuery("UPDATE businesses SET trading_name = 'PDF Auto', registration_number = '2020/123456/07', phone = '011 555 0000', address_line1 = '1 Main Road', city = 'Pretoria' WHERE id = $1", [w.businessId]);
    await ownerQuery("UPDATE finance_settings SET payment_instructions = 'Bank: Test Bank, Acc 123456', invoice_footer = 'Thanks for your business' WHERE business_id = $1", [w.businessId]);
    const p = await party(w, 'Pdf');
    const inv = await issuedInvoice(w, { customerId: p.customer.id, vehicleId: p.vehicle.id, lines: [L('Front brake pads', 2, 50_000, { sku: 'BP-77' }), L('Fitting labour', 1.5, 45_000, { lineType: 'LABOUR', discountType: 'PERCENT', discountValue: 1000 })], terms: 'Goods remain the property of the workshop until paid.' });
    const { pdf, filename } = await getInvoicePdf(w.ctx, inv.id);
    expect(filename).toBe(`${inv.number}.pdf`);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf);
    for (const s of ['TAX INVOICE', inv.number, 'PDF Auto', 'VAT no: 4123456789', 'Reg: 2020/123456/07', 'Front brake pads', 'BP-77', 'Fitting labour', 'Amount outstanding', 'Bank: Test Bank, Acc 123456', 'Goods remain the property', 'Thanks for your business', p.vehicle.registration!.replace(/\s+/g, ' ')]) {
      expect(text, s).toContain(s);
    }
    expect(text).toMatch(/VAT \(15%\)/);
    // the finalised invoice was also filed in the shared document store
    const files = await ownerQuery("SELECT original_name, mime_type FROM files WHERE resource_type = 'invoice' AND resource_id = $1", [inv.id]);
    expect(files.rows[0]).toMatchObject({ original_name: `${inv.number}.pdf`, mime_type: 'application/pdf' });
    const stored = await ownerQuery('SELECT pdf_file_id FROM invoices WHERE id = $1', [inv.id]);
    expect(stored.rows[0]!.pdf_file_id).toBeTruthy();
  });

  it('says paid and draft on the document where they apply', async () => {
    const inv = await issuedInvoice(ws);
    await pay(ws, inv.id, 145_000);
    expect(pdfText((await getInvoicePdf(ws.ctx, inv.id)).pdf)).toContain('PAID');
    const { customer } = await party(ws);
    const d = await createInvoice(ws.ctx, { customerId: customer.id, lines: [L('x', 1, 100)] });
    expect(pdfText((await getInvoicePdf(ws.ctx, d.id)).pdf)).toContain('DRAFT');
  });

  it('copes with long descriptions and non-Latin characters without failing', async () => {
    const long = 'Very long description '.repeat(13);
    const inv = await issuedInvoice(ws, { lines: [L(long, 1, 1000), L('Zoë’s “special” part — 日本', 1, 2000)] });
    const { pdf } = await getInvoicePdf(ws.ctx, inv.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfText(pdf)).toContain('Zo');
  });
});

describe('overdue and lists', () => {
  it('shows an invoice as overdue once its due date passes, marks it via the scheduler, and never marks a paid one', async () => {
    const w = await financeWorkspace('Overdue Shop');
    const late = await issuedInvoice(w, { dueInDays: -10 });
    const paidLate = await issuedInvoice(w, { dueInDays: -10 });
    await pay(w, paidLate.id, 145_000);
    const onTime = await issuedInvoice(w, { dueInDays: 5 });
    expect((await getInvoice(w.ctx, late.id)).invoice.status).toBe('OVERDUE'); // derived at read time
    expect((await ownerQuery('SELECT status FROM invoices WHERE id = $1', [late.id])).rows[0]!.status).toBe('ISSUED');
    const r = await runFinanceTasks();
    expect(r.invoicesOverdue).toBeGreaterThanOrEqual(1);
    expect((await ownerQuery('SELECT status FROM invoices WHERE id = $1', [late.id])).rows[0]!.status).toBe('OVERDUE');
    expect((await getInvoice(w.ctx, paidLate.id)).invoice.status).toBe('PAID');
    expect((await getInvoice(w.ctx, onTime.id)).invoice.status).toBe('ISSUED');
    const overdueList = await listInvoices(w.ctx, { overdue: '1' });
    expect(overdueList.items.map((i) => i.id)).toEqual([late.id]);
    expect((await runFinanceTasks()).invoicesOverdue).toBe(0);
    // paying an overdue invoice in part keeps it overdue; in full clears it
    await pay(w, late.id, 1000);
    expect((await getInvoice(w.ctx, late.id)).invoice).toMatchObject({ status: 'OVERDUE', paymentStatus: 'PARTIALLY_PAID' });
    await pay(w, late.id, 144_000);
    expect((await getInvoice(w.ctx, late.id)).invoice.status).toBe('PAID');
  });

  it('filters, searches and paginates on the server', async () => {
    const w = await financeWorkspace('List Shop');
    const a = await party(w, 'Alpha');
    const b = await party(w, 'Bravo');
    const i1 = await issuedInvoice(w, { customerId: a.customer.id, vehicleId: a.vehicle.id, lines: [L('One', 1, 10_000)] });
    const i2 = await issuedInvoice(w, { customerId: b.customer.id, vehicleId: b.vehicle.id, lines: [L('Two', 1, 20_000)] });
    const i3 = await issuedInvoice(w, { customerId: b.customer.id, lines: [L('Three', 1, 30_000)] });
    await pay(w, i3.id, 30_000, 'CASH');
    await pay(w, i2.id, 5000, 'CARD');
    expect((await listInvoices(w.ctx, { pageSize: 2 })).meta).toMatchObject({ total: 3, totalPages: 2 });
    expect((await listInvoices(w.ctx, { q: i1.number })).items.map((i) => i.id)).toEqual([i1.id]);
    expect((await listInvoices(w.ctx, { q: 'Bravo' })).items).toHaveLength(2);
    expect((await listInvoices(w.ctx, { q: b.vehicle.registration! })).items.map((i) => i.id)).toEqual([i2.id]);
    expect((await listInvoices(w.ctx, { payment: 'paid' })).items.map((i) => i.id)).toEqual([i3.id]);
    expect((await listInvoices(w.ctx, { payment: 'unpaid' })).items).toHaveLength(2);
    expect((await listInvoices(w.ctx, { status: 'PARTIALLY_PAID' })).items.map((i) => i.id)).toEqual([i2.id]);
    expect((await listInvoices(w.ctx, { method: 'CASH' })).items.map((i) => i.id)).toEqual([i3.id]);
    expect((await listInvoices(w.ctx, { minCents: 15_000, maxCents: 25_000 })).items.map((i) => i.id)).toEqual([i2.id]);
    expect((await listInvoices(w.ctx, { customerId: a.customer.id })).items).toHaveLength(1);
    expect((await listInvoices(w.ctx, { sort: 'total', dir: 'desc', pageSize: 1 })).items[0]!.id).toBe(i3.id);
    expect((await listInvoices(w.ctx, { sort: 'outstanding', dir: 'asc', pageSize: 1 })).items[0]!.outstandingCents).toBe(0);
  });
});

describe('permissions and isolation', () => {
  it('technicians cannot see invoices; advisors prepare but do not issue; accounts do everything', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    const advisor = await createMemberCtx(ws, 'service_advisor');
    const accounts = await createMemberCtx(ws, 'accounts');
    const inv = await issuedInvoice(ws);
    expect((await err(getInvoice(tech.ctx, inv.id))).code).toBe('FORBIDDEN');
    expect((await err(listInvoices(tech.ctx, {}))).code).toBe('FORBIDDEN');
    const { customer } = await party(ws);
    const d = await createInvoice(advisor.ctx, { customerId: customer.id, lines: [L('x', 1, 10_000)] });
    expect((await err(finaliseInvoice(advisor.ctx, d.id))).code).toBe('FORBIDDEN');
    expect((await writeOffInvoice(accounts.ctx, inv.id, { reason: 'ok ok' })).status).toBe('WRITTEN_OFF');
    expect((await err(writeOffInvoice(advisor.ctx, inv.id, { reason: 'ok ok' }))).code).toBe('FORBIDDEN');
    expect((await finaliseInvoice(accounts.ctx, d.id)).number).toMatch(/^INV-/);
  });

  it('another business can neither see nor change this business\'s invoices', async () => {
    const other = await createWorkspace('Other Business');
    const inv = await issuedInvoice(ws);
    for (const fn of [() => getInvoice(other.ctx, inv.id), () => finaliseInvoice(other.ctx, inv.id), () => cancelInvoice(other.ctx, inv.id, { reason: 'hack' }), () => getInvoicePdf(other.ctx, inv.id), () => recordPayment(other.ctx, { invoiceId: inv.id, amountCents: 100, method: 'CASH', idempotencyKey: key() })]) {
      expect((await err(fn())).code).toBe('NOT_FOUND');
    }
    expect((await listInvoices(other.ctx, {})).items).toHaveLength(0);
  });
});
