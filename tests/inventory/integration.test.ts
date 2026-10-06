import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { addJobLabour, addJobPart, listJobLabourAndParts, removeJobPart, updateJobPart } from '@/server/jobcards/items';
import { changeJobStatus, recordQualityCheck } from '@/server/jobcards/service';
import { createInvoice, finaliseInvoice, getInvoice } from '@/server/finance/invoices';
import { createInvoiceFromJob } from '@/server/finance/invoices';
import { createQuote, getQuote } from '@/server/finance/quotes';
import { createCreditNote, issueCreditNote } from '@/server/finance/creditnotes';
import { updatePart } from '@/server/inventory/parts';
import { adjustStock } from '@/server/inventory/stock';
import { marginReport } from '@/server/inventory/reports';
import { setDefaultLabourRate, setServiceTypeRate } from '@/server/team/labour';
import { setTechnician } from '@/server/team/technicians';
import { createMemberCtx, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { jobAt, mkPart, openJob, stock } from '../helpers/inventory';
import { invWorkspace } from '../helpers/inventory';
import { memberWithPermissions, seedCustomerVehicle } from '../helpers/workshop';
import { L } from '../helpers/finance';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await invWorkspace('Integration Workshop');
});

const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

const qc = { passed: true, checklist: { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: 'na', requested_work_completed: true } };

describe('job completion and quality control leave no phantom reservations', () => {
  it('a reserved part must be fitted or returned before the quality check can pass and before completion', async () => {
    const p = await mkPart(ws, { name: 'Wiper blade' }, 5);
    const { job } = await jobAt(ws, 'IN_PROGRESS');
    const line = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 2 });
    expect(line.status).toBe('RESERVED');
    await changeJobStatus(ws.ctx, job.id, { status: 'QUALITY_CHECK' });
    const e = await rejects(recordQualityCheck(ws.ctx, job.id, qc));
    expect(e.message).toMatch(/still reserved/);
    expect(await stock(ws, p.id)).toEqual({ onHand: 5, reserved: 2, available: 3 });
    await updateJobPart(ws.ctx, job.id, line.id, { status: 'FITTED' });
    await recordQualityCheck(ws.ctx, job.id, qc);
    await changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });

  it('completion (even by override) is refused while parts are reserved; nothing is consumed automatically', async () => {
    const p = await mkPart(ws, {}, 3);
    const { job } = await jobAt(ws, 'READY_FOR_COLLECTION');
    const line = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 1 });
    await rejects(changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED' }));
    await rejects(changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED', override: true, reason: 'Customer waiting' }));
    expect(await stock(ws, p.id)).toEqual({ onHand: 3, reserved: 1, available: 2 });
    await updateJobPart(ws.ctx, job.id, line.id, { status: 'RETURNED' });
    await changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });

  it('cancelling a job gives its reservations back', async () => {
    const p = await mkPart(ws, {}, 4);
    const { job } = await openJob(ws);
    await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 3 });
    expect((await stock(ws, p.id)).reserved).toBe(3);
    await changeJobStatus(ws.ctx, job.id, { status: 'CANCELLED', reason: 'Customer changed their mind' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 4, reserved: 0, available: 4 });
    const parts = (await listJobLabourAndParts(ws.ctx, job.id)).parts;
    expect(parts[0]!.status).toBe('RETURNED');
  });

  it('removing a reserved part releases it; a fitted part cannot be removed, only returned', async () => {
    const p = await mkPart(ws, {}, 4);
    const { job } = await openJob(ws);
    const a = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 1 });
    await removeJobPart(ws.ctx, job.id, a.id);
    expect(await stock(ws, p.id)).toEqual({ onHand: 4, reserved: 0, available: 4 });
    const b = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 1, status: 'FITTED' });
    await rejects(removeJobPart(ws.ctx, job.id, b.id));
    expect((await stock(ws, p.id)).onHand).toBe(3);
  });

  it('changing the quantity of a reserved line moves the reservation; a fitted line cannot change', async () => {
    const p = await mkPart(ws, {}, 10);
    const { job } = await openJob(ws);
    const a = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 2 });
    await updateJobPart(ws.ctx, job.id, a.id, { quantity: 5 });
    expect((await stock(ws, p.id)).reserved).toBe(5);
    await updateJobPart(ws.ctx, job.id, a.id, { quantity: 1 });
    expect((await stock(ws, p.id)).reserved).toBe(1);
    await rejects(updateJobPart(ws.ctx, job.id, a.id, { quantity: 11 }));
    await updateJobPart(ws.ctx, job.id, a.id, { status: 'FITTED' });
    await rejects(updateJobPart(ws.ctx, job.id, a.id, { quantity: 2 }));
  });

  it('parts typed in by hand (not from the catalogue) never touch stock', async () => {
    const p = await mkPart(ws, {}, 2);
    const { job } = await openJob(ws);
    const free = await addJobPart(ws.ctx, job.id, { description: 'Special order clip', quantity: 1, status: 'FITTED' });
    expect(free.status).toBe('FITTED');
    expect(await stock(ws, p.id)).toEqual({ onHand: 2, reserved: 0, available: 2 });
    await rejects(addJobPart(ws.ctx, job.id, { quantity: 1 }));
  });
});

describe('prices and costs are kept as they were', () => {
  it('invoices a fitted part at the job\'s price and cost, however the catalogue changes later', async () => {
    const w = await invWorkspace('Price Snapshot');
    const p = await mkPart(w, { name: 'Brake pads', costCents: 20_000, sellPriceCents: 35_000 }, 5);
    const { job, customer, vehicle } = await jobAt(w, 'READY_FOR_COLLECTION');
    const line = await addJobPart(w.ctx, job.id, { inventoryItemId: p.id, quantity: 2 });
    // the catalogue cost changes before the part is used: the cost is taken when it is used
    await updatePart(w.ctx, p.id, { costCents: 22_000 });
    await updateJobPart(w.ctx, job.id, line.id, { status: 'FITTED' });
    const afterFit = (await listJobLabourAndParts(w.ctx, job.id)).parts[0]!;
    expect(afterFit).toMatchObject({ catalogue: true, sellPriceCents: 35_000, costCents: 22_000, status: 'FITTED' });
    // later catalogue changes do not touch the job or the invoice
    await updatePart(w.ctx, p.id, { sellPriceCents: 99_900, costCents: 50_000 });
    const draft = await createInvoiceFromJob(w.ctx, job.id);
    const inv = await getInvoice(w.ctx, draft.id);
    const l = inv.lines[0]!;
    expect(l).toMatchObject({ lineType: 'PART', unitPriceCents: 35_000, quantityMilli: 2000, unitCostCents: 22_000, inventoryItemId: p.id });
    expect(inv.invoice.totalCents).toBe(70_000);
    void customer; void vehicle;
    await finaliseInvoice(w.ctx, draft.id);
    const m = await marginReport(w.ctx, { by: 'part' });
    expect(m.items[0]).toMatchObject({ revenueCents: 70_000, costCents: 44_000, marginCents: 26_000 });
    expect(m.items[0]!.label).toContain('Brake pads');
    const byJob = await marginReport(w.ctx, { by: 'job' });
    expect(byJob.items[0]!.label).toBe(job.jobNumber);
  });

  it('a part that is only reserved is never billed', async () => {
    const w = await invWorkspace('Reserved Not Billed');
    const p = await mkPart(w, {}, 5);
    const { job } = await jobAt(w, 'READY_FOR_COLLECTION');
    await addJobPart(w.ctx, job.id, { inventoryItemId: p.id, quantity: 1 });
    await addJobLabour(w.ctx, job.id, { description: 'Fit', minutes: 30, rateCentsPerHour: 60_000 });
    const draft = await createInvoiceFromJob(w.ctx, job.id);
    const inv = await getInvoice(w.ctx, draft.id);
    expect(inv.lines.map((l) => l.lineType)).toEqual(['LABOUR']);
  });

  it('returning a part that is on an invoice needs the proper credit note first', async () => {
    const w = await invWorkspace('Invoiced Return');
    const p = await mkPart(w, { sellPriceCents: 10_000 }, 5);
    const { job } = await jobAt(w, 'READY_FOR_COLLECTION');
    const line = await addJobPart(w.ctx, job.id, { inventoryItemId: p.id, quantity: 1, status: 'FITTED' });
    const draft = await createInvoiceFromJob(w.ctx, job.id);
    // on a draft invoice: fix the invoice first
    const e1 = await rejects(updateJobPart(w.ctx, job.id, line.id, { status: 'RETURNED' }));
    expect(e1.message).toMatch(/draft invoice/);
    const inv = await finaliseInvoice(w.ctx, draft.id);
    const e2 = await rejects(updateJobPart(w.ctx, job.id, line.id, { status: 'RETURNED' }));
    expect(e2.message).toMatch(new RegExp(`credit note.*${inv.number}|${inv.number}.*credit note`, 's'));
    expect((await stock(w, p.id)).onHand).toBe(4);
    // the issued invoice is never rewritten
    const frozen = await getInvoice(w.ctx, draft.id);
    expect(frozen.lines).toHaveLength(1);
    // with a credit note, and an explicit acknowledgement, the part can go back on the shelf
    const cn = await createCreditNote(w.ctx, { invoiceId: draft.id, reason: 'Part returned', lines: [L('Returned part', 1, 10_000)] });
    await issueCreditNote(w.ctx, cn.id);
    const e3 = await rejects(updateJobPart(w.ctx, job.id, line.id, { status: 'RETURNED' }));
    expect((e3.details as { code?: string }).code).toBe('NEEDS_CREDIT_NOTE_ACK');
    await updateJobPart(w.ctx, job.id, line.id, { status: 'RETURNED', acknowledgeCreditNote: true });
    expect((await stock(w, p.id)).onHand).toBe(5);
    expect((await getInvoice(w.ctx, draft.id)).lines).toHaveLength(1);
  });
});

describe('quotes and invoices can name catalogue parts', () => {
  it('fills in the cost from the catalogue and refuses another business\'s part', async () => {
    const w = await invWorkspace('Doc Parts');
    const other = await invWorkspace('Doc Other');
    const p = await mkPart(w, { sku: 'FLT-1', costCents: 8_000, sellPriceCents: 12_000 });
    const foreign = await mkPart(other);
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Doc');
    const q = await createQuote(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, lines: [{ lineType: 'PART', description: 'Oil filter', inventoryItemId: p.id, quantityMilli: 1000, unitPriceCents: 12_000 }] });
    const stored = await getQuote(w.ctx, q.id);
    expect(stored.lines[0]).toMatchObject({ inventoryItemId: p.id, sku: 'FLT-1', unitCostCents: 8_000 });
    await rejects(createQuote(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, lines: [{ lineType: 'PART', description: 'Stolen', inventoryItemId: foreign.id, quantityMilli: 1000, unitPriceCents: 1 }] }));
    await rejects(createInvoice(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, lines: [{ lineType: 'LABOUR', description: 'Not a part', inventoryItemId: p.id, quantityMilli: 1000, unitPriceCents: 1 }] }));
    // a quote or invoice does not itself move stock
    expect((await stock(w, p.id)).onHand).toBe(0);
  });

  it('a person who cannot see costs still gets the cost recorded for profit reporting', async () => {
    const w = await invWorkspace('Doc Cost');
    const p = await mkPart(w, { costCents: 5_000 });
    const advisor = await memberWithPermissions(w, ['customer.view', 'vehicle.view', 'quote.view', 'quote.create', 'inventory.view']);
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Doc');
    const q = await createQuote(advisor.ctx, { customerId: customer.id, vehicleId: vehicle.id, lines: [{ lineType: 'PART', description: 'Part', inventoryItemId: p.id, quantityMilli: 1000, unitPriceCents: 9_000, unitCostCents: 1 }] });
    const row = (await ownerQuery('SELECT unit_cost_cents FROM quote_lines ql JOIN quote_versions qv ON qv.id = ql.version_id WHERE qv.quote_id = $1', [q.id])).rows[0]!;
    expect(row.unit_cost_cents).toBe(5_000);
  });
});

describe('technicians and cost visibility', () => {
  it('a technician can reserve and use parts on their job but never sees costs or adjusts stock', async () => {
    const w = await invWorkspace('Tech Parts');
    const tech = await createMemberCtx(w, 'technician');
    const p = await mkPart(w, { costCents: 7_000, sellPriceCents: 9_000 }, 5);
    const { job } = await openJob(w, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    const added = await addJobPart(tech.ctx, job.id, { inventoryItemId: p.id, quantity: 1 });
    expect(added.status).toBe('RESERVED');
    await updateJobPart(tech.ctx, job.id, added.id, { status: 'FITTED' });
    const seen = (await listJobLabourAndParts(tech.ctx, job.id)).parts[0]!;
    expect(seen).toMatchObject({ costCents: null, sellPriceCents: null });
    await rejects(adjustStock(tech.ctx, { partId: p.id, kind: 'INCREASE', quantity: 100, reasonCode: 'OTHER', reason: 'Trying my luck' }));
    await rejects(addJobPart(tech.ctx, job.id, { inventoryItemId: p.id, quantity: 1, costCents: 1 }));
    // the cost WAS recorded server-side for the workshop's own reports
    const row = (await ownerQuery('SELECT cost_cents FROM job_parts WHERE id = $1', [added.id])).rows[0]!;
    expect(row.cost_cents).toBe(7_000);
    // and a technician who is not on the job cannot touch its parts
    const other = await createMemberCtx(w, 'technician');
    await rejects(addJobPart(other.ctx, job.id, { inventoryItemId: p.id, quantity: 1 }));
  });
});

describe('labour rates', () => {
  it('uses the technician\'s rate, then the service rate, then the default, and copies it onto the line', async () => {
    const w = await invWorkspace('Labour Rates');
    const tech = await createMemberCtx(w, 'technician');
    await setDefaultLabourRate(w.ctx, { rateCentsPerHour: 50_000 });
    const { job } = await openJob(w, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    const first = await addJobLabour(w.ctx, job.id, { description: 'Diagnose', minutes: 60, technicianMembershipId: tech.ctx.membership.id });
    expect(first).toMatchObject({ rateCentsPerHour: 50_000, totalCents: 50_000 });
    const svc = (await ownerQuery<{ id: string }>('SELECT id FROM service_types WHERE business_id = $1 LIMIT 1', [w.businessId])).rows[0]!.id;
    await ownerQuery('UPDATE job_cards SET service_type_id = $2 WHERE id = $1', [job.id, svc]);
    await setServiceTypeRate(w.ctx, svc, { rateCentsPerHour: 60_000 });
    const second = await addJobLabour(w.ctx, job.id, { description: 'Service', minutes: 60, technicianMembershipId: tech.ctx.membership.id });
    expect(second.rateCentsPerHour).toBe(60_000);
    await setTechnician(w.ctx, tech.ctx.membership.id, { billableRateCentsPerHour: 75_000 });
    const third = await addJobLabour(w.ctx, job.id, { description: 'Repair', minutes: 30, technicianMembershipId: tech.ctx.membership.id });
    expect(third).toMatchObject({ rateCentsPerHour: 75_000, totalCents: 37_500 });
    // changing a rate later rewrites nothing that already exists
    await setTechnician(w.ctx, tech.ctx.membership.id, { billableRateCentsPerHour: 99_000 });
    const rows = (await ownerQuery('SELECT rate_cents_per_hour FROM job_labour WHERE job_id = $1 ORDER BY created_at', [job.id])).rows.map((r) => r.rate_cents_per_hour);
    expect(rows).toEqual([50_000, 60_000, 75_000]);
    const audit = await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND action = 'labour.rate_changed'", [w.businessId]);
    expect(audit.rows[0]!.n).toBe(4); // default, service, two technician changes
  });
});
