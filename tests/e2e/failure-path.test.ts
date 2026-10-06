import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { changeJobStatus, getJobCard, recordQualityCheck } from '@/server/jobcards/service';
import { addJobPart, updateJobPart } from '@/server/jobcards/items';
import { createRecommendedWork, startInspection, completeInspection, updateInspectionItem } from '@/server/jobcards/work';
import { createQuote, getQuote, sendQuote, updateQuote } from '@/server/finance/quotes';
import { decideQuotePublic } from '@/server/finance/quote-public';
import { createInvoiceFromJob, finaliseInvoice, getInvoice, listInvoices } from '@/server/finance/invoices';
import { createPurchaseOrder, placePurchaseOrder } from '@/server/inventory/purchasing';
import { receiveGoods } from '@/server/inventory/receiving';
import { runReport } from '@/server/reports/run';
import { createMemberCtx, ownerQuery, testMeta, type TestWorkspace } from '../helpers/factory';
import { idem, invWorkspace, mkPart, mkSupplier, openJob, stock } from '../helpers/inventory';
import { backdateInvoice, pay, tokenOf } from '../helpers/finance';

afterAll(disconnectPrisma);

/**
 * The unhappy path: a declined quote, a revised quote, a part that is not in stock, a late delivery, a part payment, an overdue invoice and a final
 * payment. Every state must stay coherent and nothing may be double-counted.
 */
let ws: TestWorkspace;
const S: Record<string, any> = {};
const meta = () => testMeta('203.0.113.77');
const err = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

beforeAll(async () => {
  ws = await invWorkspace('Failure Path Motors');
  S.tech = await createMemberCtx(ws, 'technician');
});

describe('declined, revised, approved', () => {
  it('a declined quote stays declined; the revision is a new version; the old version can no longer be approved', async () => {
    const made = await openJob(ws, { primaryTechnicianMembershipId: S.tech.ctx.membership.id });
    S.job = made.job;
    S.customer = made.customer;
    await ownerQuery("UPDATE job_cards SET opened_at = now() - interval '1 day' WHERE id = $1", [S.job.id]);
    await startInspection(S.tech.ctx, S.job.id);
    const card = await getJobCard(ws.ctx, S.job.id);
    await updateInspectionItem(S.tech.ctx, S.job.id, card.inspection!.items.find((i) => i.itemKey === 'brakes')!.id, { status: 'CRITICAL', customerNotes: 'Pads worn' });
    await completeInspection(S.tech.ctx, S.job.id);
    await changeJobStatus(S.tech.ctx, S.job.id, { status: 'DIAGNOSIS' });
    S.work = await createRecommendedWork(S.tech.ctx, S.job.id, { description: 'Replace front brake pads', priority: 'URGENT' });
    await changeJobStatus(ws.ctx, S.job.id, { status: 'AWAITING_APPROVAL' });

    S.part = await mkPart(ws, { name: 'Brake pad set', costCents: 30_000, sellPriceCents: 80_000 }, 0); // none on the shelf
    const q = await createQuote(ws.ctx, {
      customerId: S.customer.id, vehicleId: made.vehicle.id, jobId: S.job.id,
      lines: [{ lineType: 'PART', description: 'Replace front brake pads', quantityMilli: 1000, unitPriceCents: 300_000, recommendedWorkId: S.work.id }],
    });
    const sent1 = await sendQuote(ws.ctx, q.id);
    S.quote = { id: q.id, token: tokenOf(sent1.customerUrl) };
    await decideQuotePublic(S.quote.token, { action: 'decline', version: 1, name: 'Sam', comment: 'Too expensive' }, meta());
    expect((await getQuote(ws.ctx, q.id)).quote.status).toBe('DECLINED');
    expect((await getJobCard(ws.ctx, S.job.id)).recommendedWork[0]!.approvalStatus).toBe('DECLINED'); // a decline approves nothing, and marks the work declined
    await err(changeJobStatus(ws.ctx, S.job.id, { status: 'APPROVED' }));

    const v2 = await updateQuote(ws.ctx, q.id, {
      lines: [{ lineType: 'PART', description: 'Replace front brake pads (budget set)', quantityMilli: 1000, unitPriceCents: 220_000, recommendedWorkId: S.work.id }],
      changeNote: 'Customer asked for a cheaper brand',
    });
    expect(v2).toMatchObject({ version: 2 });
    const sent2 = await sendQuote(ws.ctx, q.id);
    const token2 = tokenOf(sent2.customerUrl);
    // the customer holding the OLD page cannot approve the old version
    const stale = await err(decideQuotePublic(token2, { action: 'approve', version: 1, name: 'Sam', acceptTerms: true }, meta()));
    expect(['CONFLICT', 'VALIDATION_ERROR']).toContain(stale.code);
    expect((await getQuote(ws.ctx, q.id)).quote.status).not.toBe('APPROVED');
    await decideQuotePublic(token2, { action: 'approve', version: 2, name: 'Sam', acceptTerms: true }, meta());
    const approved = await getQuote(ws.ctx, q.id);
    expect(approved.quote).toMatchObject({ status: 'APPROVED', approvedVersion: 2 });
    expect(approved.version.totalCents).toBe(220_000);
    // the newer, explicit approval supersedes the earlier decline of the same work (otherwise the job could never be approved), and says so
    const work = (await getJobCard(ws.ctx, S.job.id)).recommendedWork[0]!;
    expect(work.approvalStatus).toBe('APPROVED');
    expect(work.decisionNote).toMatch(/after an earlier decline/);
    const aud = await ownerQuery<{ metadata: { supersededDeclines?: number } }>("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'quote.approved'", [ws.businessId]);
    expect(aud.rows[0]!.metadata.supersededDeclines).toBe(1);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'quote.declined'", [ws.businessId])).rowCount).toBe(1); // the decline is still on record
    await changeJobStatus(ws.ctx, S.job.id, { status: 'APPROVED' });
  });
});

describe('part unavailable, awaiting parts, stock received, work continues', () => {
  it('cannot fit what is not on the shelf; waits; the delivery makes it available; work resumes', async () => {
    // not in stock: the part is only REQUESTED; nothing is promised that does not exist
    const wanted = await addJobPart(S.tech.ctx, S.job.id, { inventoryItemId: S.part.id, quantity: 1 });
    expect(wanted.status).toBe('REQUESTED');
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    await err(updateJobPart(S.tech.ctx, S.job.id, wanted.id, { status: 'RESERVED' })); // cannot reserve what is not there
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    await changeJobStatus(ws.ctx, S.job.id, { status: 'AWAITING_PARTS' });
    expect((await getJobCard(ws.ctx, S.job.id)).job.status).toBe('AWAITING_PARTS');

    const supplier = await mkSupplier(ws, 'Brake World');
    const po = await createPurchaseOrder(ws.ctx, { supplierId: supplier.id, lines: [{ partId: S.part.id, quantity: 2, unitCostCents: 30_000 }] });
    await placePurchaseOrder(ws.ctx, po.id);
    const lines = (await ownerQuery<{ id: string }>('SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1', [po.id])).rows;
    // a partial delivery first, then the rest: on hand follows exactly what was received
    await receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), lines: [{ poLineId: lines[0]!.id, quantityReceived: 1 }] });
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 1, reserved: 0, available: 1 });
    await receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), lines: [{ poLineId: lines[0]!.id, quantityReceived: 1 }] });
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 2, reserved: 0, available: 2 });
    expect((await ownerQuery<{ status: string }>('SELECT status FROM purchase_orders WHERE id = $1', [po.id])).rows[0]!.status).toBe('RECEIVED');

    await changeJobStatus(S.tech.ctx, S.job.id, { status: 'IN_PROGRESS' });
    const line = await updateJobPart(S.tech.ctx, S.job.id, wanted.id, { status: 'RESERVED' }); // the same line, now that it can be reserved
    expect(line.status).toBe('RESERVED');
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 2, reserved: 1, available: 1 });
    await updateJobPart(S.tech.ctx, S.job.id, line.id, { status: 'FITTED' });
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 1, reserved: 0, available: 1 });
    await changeJobStatus(S.tech.ctx, S.job.id, { status: 'QUALITY_CHECK' });
    await recordQualityCheck(ws.ctx, S.job.id, { passed: true, checklist: { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: 'na', requested_work_completed: true } });
    await changeJobStatus(ws.ctx, S.job.id, { status: 'COMPLETED' });
    expect((await getJobCard(ws.ctx, S.job.id)).job.status).toBe('COMPLETED');
  });
});

describe('invoice, part payment, overdue, final payment', () => {
  it('the invoice follows the approved quote, goes overdue when unpaid past its due date, and settles exactly', async () => {
    const draft = await createInvoiceFromJob(ws.ctx, S.job.id);
    await finaliseInvoice(ws.ctx, draft.id);
    S.invoice = draft.id;
    const inv = (await getInvoice(ws.ctx, draft.id)).invoice;
    S.total = inv.totalCents;
    expect(inv.totalCents).toBeGreaterThan(0);
    expect((await ownerQuery<{ status: string }>('SELECT status FROM quotes WHERE id = $1', [S.quote.id])).rows[0]!.status).toBe('CONVERTED'); // quote -> invoice exactly once
    expect((await err(createInvoiceFromJob(ws.ctx, S.job.id))).status).toBe(409);

    const part1 = Math.round(S.total * 0.4);
    await pay(ws, draft.id, part1, 'EFT');
    let now = (await getInvoice(ws.ctx, draft.id)).invoice;
    expect(now).toMatchObject({ paymentStatus: 'PARTIALLY_PAID', paidCents: part1, outstandingCents: S.total - part1 });

    await backdateInvoice(draft.id, -5); // five days past due
    now = (await getInvoice(ws.ctx, draft.id)).invoice;
    expect(now).toMatchObject({ outstandingCents: S.total - part1 });
    const listed = (await listInvoices(ws.ctx, { status: 'OVERDUE' })).items.map((i: { id: string }) => i.id);
    expect(listed).toContain(draft.id);
    const rec = await runReport(ws.ctx, 'receivables', {});
    expect(rec.summary!.find((m) => m.key === 'overdue')!.value).toBe(S.total - part1);

    // overpaying by accident is refused as an invoice payment: the excess becomes customer credit, never a negative balance
    await pay(ws, draft.id, S.total - part1, 'CASH');
    const paid = (await getInvoice(ws.ctx, draft.id)).invoice;
    expect(paid).toMatchObject({ paymentStatus: 'PAID', paidCents: S.total, outstandingCents: 0 });
    expect((await listInvoices(ws.ctx, { status: 'OVERDUE' })).items.map((i: { id: string }) => i.id)).not.toContain(draft.id);
    const rec2 = await runReport(ws.ctx, 'receivables', {});
    expect(rec2.summary!.find((m) => m.key === 'total')!.value).toBe(0);
    const rev = await runReport(ws.ctx, 'revenue', { preset: 'THIS_YEAR' });
    expect(rev.summary!.find((m) => m.key === 'received')!.value).toBe(S.total);
  });

  it('every record of the story is still there and consistent', async () => {
    const counts = (await ownerQuery<Record<string, number>>(
      `SELECT (SELECT count(*) FROM invoices WHERE business_id = $1 AND status <> 'CANCELLED')::int AS invoices,
              (SELECT count(*) FROM payments WHERE business_id = $1)::int AS payments,
              (SELECT count(*) FROM receipts WHERE business_id = $1)::int AS receipts,
              (SELECT count(*) FROM quote_versions WHERE business_id = $1)::int AS versions`, [ws.businessId])).rows[0]!;
    expect(counts).toEqual({ invoices: 1, payments: 2, receipts: 2, versions: 2 });
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 1, reserved: 0, available: 1 });
  });
});
