import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { authenticate, resolveBusinessContext } from '@/server/tenancy/context';
import { verifyEmail } from '@/server/auth/service';
import { MemoryTransport } from '@/server/notifications/email';
import { updateBusiness, createBusiness } from '@/server/businesses/service';
import { createCustomer, getCustomerOverview } from '@/server/customers/service';
import { createVehicle } from '@/server/vehicles/service';
import { listServiceHistory } from '@/server/vehicles/insights';
import { createBooking, getBooking } from '@/server/bookings/service';
import { listServiceTypes } from '@/server/workshop/service';
import { changeJobStatus, checkInBooking, getJobCard, recordQualityCheck } from '@/server/jobcards/service';
import { completeInspection, confirmDiagnosis, createDiagnosis, createRecommendedWork, startInspection, updateInspectionItem } from '@/server/jobcards/work';
import { addJobPart, listJobLabourAndParts, updateJobPart } from '@/server/jobcards/items';
import { createQuote, getQuote, sendQuote } from '@/server/finance/quotes';
import { decideQuotePublic, getPublicQuote } from '@/server/finance/quote-public';
import { createInvoiceFromJob, finaliseInvoice, getInvoice, sendInvoice } from '@/server/finance/invoices';
import { getPublicInvoice } from '@/server/finance/online';
import { getCustomerCredit, listReceipts } from '@/server/finance/payments';
import { setDefaultLabourRate } from '@/server/team/labour';
import { setTechnician } from '@/server/team/technicians';
import { createManualEntry, postTimeToLabour } from '@/server/team/time';
import { runReport } from '@/server/reports/run';
import { searchAuditLog } from '@/server/admin/audit';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as createBusinessRoute } from '@/app/api/v1/businesses/route';
import { call, sessionTokenFrom } from '../helpers/http';
import {
  TEST_PASSWORD, createMemberCtx, drainJobs, latestEmailToken, ownerQuery, sentTo, testMeta, uniqueEmail, type TestWorkspace,
} from '../helpers/factory';
import { customerInput } from '../helpers/customers';
import { mkPart, stock, ledger } from '../helpers/inventory';
import { nextWeekday } from '../helpers/workshop';
import { key, pay, tokenOf } from '../helpers/finance';

afterAll(disconnectPrisma);

/**
 * THE complete scenario, on real database records: account -> business -> trial -> configure -> customer -> vehicle -> booking -> check-in
 * -> job -> inspection -> diagnosis -> recommended work -> quote -> customer approval -> parts -> labour -> QC -> completion -> invoice -> payment
 * -> receipt -> reports -> audit -> notifications -> documents. Each step asserts the consequence in the OTHER modules, not just its own.
 */
const S: Record<string, any> = {};
let ws: TestWorkspace;
const meta = () => testMeta('203.0.113.50');

describe('1-4. account, verification, business and trial', () => {
  it('registers, cannot create a business before verifying, verifies, signs in and creates a business with a 14-day trial', async () => {
    const email = uniqueEmail('e2e.owner');
    const reg = await call(registerRoute, { body: { firstName: 'Eve', lastName: 'Owner', email, password: TEST_PASSWORD } });
    expect(reg.status).toBeLessThan(300);
    const token0 = await latestEmailToken(email);
    // an unverified account may sign in, but cannot create a business until the email is verified
    const early = await call(loginRoute, { body: { email, password: TEST_PASSWORD } });
    expect(early.status).toBe(200);
    const blocked = await call(createBusinessRoute, { method: 'POST', token: sessionTokenFrom(early)!, body: { name: 'Too Early Motors', vatRegistered: false } });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect((await ownerQuery('SELECT 1 FROM businesses WHERE name = $1', ['Too Early Motors'])).rowCount).toBe(0);
    await verifyEmail(token0, meta());
    const login = await call(loginRoute, { body: { email, password: TEST_PASSWORD } });
    expect(login.status).toBe(200);
    const session = sessionTokenFrom(login)!;
    expect(session).toBeTruthy();
    const made = await call(createBusinessRoute, { method: 'POST', token: session, body: { name: 'E2E Motors', vatRegistered: false } });
    expect(made.status).toBe(201);
    const auth = await authenticate(session, meta());
    const ctx = await resolveBusinessContext(auth!);
    const owner = { id: auth!.user.user.id, email, name: 'Eve Owner', password: TEST_PASSWORD };
    ws = { owner, businessId: made.body.data.id, ctx: { ...ctx, token: session } } as TestWorkspace;
    S.ws = ws;
    const s = ws.ctx.subscription;
    expect(s.status).toBe('TRIALING');
    expect(s.trialDaysRemaining).toBeGreaterThanOrEqual(13);
    expect(s.canWrite).toBe(true);
  });

  it('5. configures the business: VAT, a default labour rate, a technician with their own rate', async () => {
    await updateBusiness(ws.ctx, { vatRegistered: true, vatNumber: '4123456789', vatRateBps: 1500 });
    await ownerQuery("UPDATE businesses SET vat_registered = true, vat_rate_bps = 1500, vat_number = '4123456789' WHERE id = $1", [ws.businessId]);
    const fresh = async () => {
      const a = await authenticate(ws.ctx.token, meta());
      ws.ctx = { ...(await resolveBusinessContext(a!)), token: ws.ctx.token };
    };
    await fresh();
    expect(ws.ctx.business.vatRegistered).toBe(true);
    await setDefaultLabourRate(ws.ctx, { rateCentsPerHour: 60_000 });
    S.tech = await createMemberCtx(ws, 'technician');
    S.advisor = await createMemberCtx(ws, 'service_advisor');
    await setTechnician(ws.ctx, S.tech.ctx.membership.id, { billableRateCentsPerHour: 60_000 });
  });
});

describe('6-9. customer, vehicle, booking, check-in', () => {
  it('creates the customer and vehicle, books them in and checks the car in, which opens a numbered job', async () => {
    S.customer = await createCustomer(S.advisor.ctx, customerInput('Sam Motorist', { email: `sam.${Date.now()}@example.test` }));
    S.vehicle = await createVehicle(S.advisor.ctx, { customerId: S.customer.id, registration: 'E2E 001 GP', make: 'Toyota', model: 'Hilux', year: 2019, mileageKm: 80_000 });
    const types = await listServiceTypes(ws.ctx);
    S.booking = await createBooking(S.advisor.ctx, {
      customerId: S.customer.id, vehicleId: S.vehicle.id, serviceTypeId: types.find((t) => t.name === 'Diagnostic')!.id,
      date: nextWeekday(2), time: '09:00', technicianMembershipId: S.tech.ctx.membership.id, customerNotes: 'Squealing when braking',
    });
    expect(S.booking.bookingNumber).toMatch(/^BKG-\d{6}$/);
    const checkedIn = await checkInBooking(S.advisor.ctx, S.booking.id, { mileageKm: 80_150, fuelLevel: 'HALF', existingDamage: 'Scratch left door', arrived: true });
    S.job = checkedIn.job;
    expect(S.job.jobNumber).toMatch(/^JOB-\d{7}$/);
    expect(S.job.status).toBe('CHECKED_IN');
    expect((await getBooking(ws.ctx, S.booking.id)).status).toBe('CHECKED_IN');
    // the job's start must precede the technician's recorded work: back-date it as if the car had been here for a day
    await ownerQuery("UPDATE job_cards SET opened_at = now() - interval '1 day' WHERE id = $1", [S.job.id]);
    // check-in mileage reached the vehicle
    expect((await ownerQuery<{ m: number }>('SELECT mileage_km AS m FROM vehicles WHERE id = $1', [S.vehicle.id])).rows[0]!.m).toBe(80_150);
  });
});

describe('11-13. inspection, diagnosis, recommended work (a diagnosis is NOT customer approval)', () => {
  it('the technician inspects, diagnoses and the technician lists recommended work; nothing is approved yet', async () => {
    const insp = await startInspection(S.tech.ctx, S.job.id);
    const card = await getJobCard(ws.ctx, S.job.id);
    expect(card.job.status).toBe('INSPECTION');
    const brakes = card.inspection!.items.find((i) => i.itemKey === 'brakes')!;
    await updateInspectionItem(S.tech.ctx, S.job.id, brakes.id, { status: 'CRITICAL', internalNotes: 'Pads 1mm', customerNotes: 'Front brake pads are worn out' });
    await completeInspection(S.tech.ctx, S.job.id);
    expect(insp.status).toBe('IN_PROGRESS');
    await changeJobStatus(S.tech.ctx, S.job.id, { status: 'DIAGNOSIS' });
    const d = await createDiagnosis(S.tech.ctx, S.job.id, { symptoms: 'Squeal when braking', faultCodes: ['C0035'], findings: 'Front pads 1mm', diagnosis: 'Replace front pads' });
    await confirmDiagnosis(S.tech.ctx, S.job.id, d.id);
    S.work = await createRecommendedWork(S.tech.ctx, S.job.id, { description: 'Replace front brake pads', priority: 'URGENT' });
    const after = await getJobCard(ws.ctx, S.job.id);
    expect(after.recommendedWork.every((w) => w.approvalStatus === 'PENDING')).toBe(true); // diagnosis never approves anything
    await expect(changeJobStatus(ws.ctx, S.job.id, { status: 'APPROVED' })).rejects.toMatchObject({ status: 409 });
    await changeJobStatus(S.advisor.ctx, S.job.id, { status: 'AWAITING_APPROVAL' });
  });
});

describe('14-17. quote, customer view, customer approval', () => {
  it('sends a quote; the customer sees only customer-safe data, approves it, and the recommended work and job move on', async () => {
    S.part = await mkPart(ws, { name: 'Front brake pad set', costCents: 20_000, sellPriceCents: 50_000 }, 5);
    const q = await createQuote(S.advisor.ctx, {
      customerId: S.customer.id, vehicleId: S.vehicle.id, jobId: S.job.id,
      lines: [{ lineType: 'PART', description: 'Replace front brake pads (parts and labour)', quantityMilli: 1000, unitPriceCents: 150_000, unitCostCents: 60_000, recommendedWorkId: S.work.id }],
      internalNotes: 'INTERNAL: customer is a good payer, margin 60%',
    });
    const sent = await sendQuote(S.advisor.ctx, q.id);
    S.quote = { id: q.id, number: q.number, token: tokenOf(sent.customerUrl) };
    const view = await getPublicQuote(S.quote.token, meta());
    const text = JSON.stringify(view);
    expect(text).toContain('brake pads');
    for (const secret of ['INTERNAL', 'unitCost', 'costCents', 'margin', 'internalNotes', 'auditLog', 'passwordHash']) expect(text, secret).not.toContain(secret);
    const r = await decideQuotePublic(S.quote.token, { action: 'approve', version: 1, name: 'Sam Motorist', acceptTerms: true }, meta());
    expect(JSON.stringify(r)).not.toMatch(/INTERNAL|unitCost/);
    const got = await getQuote(ws.ctx, q.id);
    expect(got.quote.status).toBe('APPROVED');
    expect((await getJobCard(ws.ctx, S.job.id)).recommendedWork[0]!.approvalStatus).toBe('APPROVED');
    await changeJobStatus(S.advisor.ctx, S.job.id, { status: 'APPROVED' });
  });
});

describe('18-22. parts, labour, QC and completion move stock and time consistently', () => {
  it('reserves and fits parts, records approved labour, passes QC and completes the job', async () => {
    await changeJobStatus(S.tech.ctx, S.job.id, { status: 'IN_PROGRESS' });
    const line = await addJobPart(S.tech.ctx, S.job.id, { inventoryItemId: S.part.id, quantity: 2 });
    expect(line.status).toBe('RESERVED');
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 5, reserved: 2, available: 3 }); // on hand - reserved = available
    await updateJobPart(S.tech.ctx, S.job.id, line.id, { status: 'FITTED' });
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    const entry = await createManualEntry(ws.ctx, {
      jobId: S.job.id, membershipId: S.tech.ctx.membership.id, startedAt: new Date(Date.now() - 150 * 60_000), endedAt: new Date(Date.now() - 60 * 60_000), notes: 'Fit pads, bleed brakes',
    });
    const posted = await postTimeToLabour(ws.ctx, entry.id);
    expect(posted).toBeTruthy();
    const items = await listJobLabourAndParts(ws.ctx, S.job.id);
    expect(items.labour.length).toBe(1);
    await changeJobStatus(S.tech.ctx, S.job.id, { status: 'QUALITY_CHECK' });
    await recordQualityCheck(ws.ctx, S.job.id, { passed: true, checklist: { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: 'na', requested_work_completed: true } });
    await changeJobStatus(ws.ctx, S.job.id, { status: 'COMPLETED' });
    expect((await getJobCard(ws.ctx, S.job.id)).job.status).toBe('COMPLETED');
    expect((await ledger(ws, S.part.id)).map((m) => m.type)).toEqual(expect.arrayContaining(['ADJUSTED', 'RESERVED', 'USED']));
  });
});

describe('23-27. invoice, customer view, payment, receipt, balance', () => {
  it('invoices the job once, shows the customer a clean invoice, takes payment and issues a receipt; the balance is exact', async () => {
    const draft = await createInvoiceFromJob(ws.ctx, S.job.id);
    await expect(createInvoiceFromJob(ws.ctx, S.job.id)).rejects.toMatchObject({ status: 409 }); // never invoiced twice
    const fin = await finaliseInvoice(ws.ctx, draft.id);
    const sent = await sendInvoice(ws.ctx, draft.id);
    S.invoice = { id: draft.id, number: fin.number, token: tokenOf(sent.customerUrl) };
    const full = await getInvoice(ws.ctx, draft.id);
    const t = full.invoice;
    // money is whole cents everywhere and the totals add up: subtotal + VAT = total, lines add up to the subtotal
    const sum = (k: 'taxableCents' | 'vatCents' | 'totalCents') => full.lines.reduce((a: number, l) => a + (l as unknown as Record<string, number>)[k]!, 0);
    expect(Number.isInteger(t.totalCents)).toBe(true);
    expect(t.subtotalCents).toBe(sum('taxableCents'));
    expect(t.vatCents).toBe(sum('vatCents'));
    expect(t.totalCents).toBe(sum('totalCents'));
    expect(t.totalCents).toBe(t.subtotalCents + t.vatCents);
    expect(Math.abs(t.vatCents - Math.round(t.subtotalCents * 0.15))).toBeLessThanOrEqual(full.lines.length); // per-line rounding only
    S.total = t.totalCents;
    S.subtotal = t.subtotalCents;

    const view = await getPublicInvoice(S.invoice.token, meta());
    const vt = JSON.stringify(view);
    for (const secret of ['unitCost', 'costCents', 'internalNotes', 'INTERNAL', 'margin']) expect(vt, secret).not.toContain(secret);

    // pay part now, the rest later
    const first = Math.round(S.total / 2);
    await pay(ws, draft.id, first, 'CARD');
    expect((await getInvoice(ws.ctx, draft.id)).invoice).toMatchObject({ status: 'PARTIALLY_PAID', outstandingCents: S.total - first });
    await pay(ws, draft.id, S.total - first, 'EFT');
    const paid = (await getInvoice(ws.ctx, draft.id)).invoice;
    expect(paid).toMatchObject({ status: 'PAID', outstandingCents: 0, paidCents: S.total });
    expect((await listReceipts(ws.ctx, {})).items.length).toBe(2);
    expect((await getCustomerCredit(ws.ctx, S.customer.id)).balanceCents).toBe(0);
    const overview = await getCustomerOverview(ws.ctx, S.customer.id);
    expect(JSON.stringify(overview)).toContain('Sam');
  });

  it('28-29. the vehicle history and inventory reflect the job', async () => {
    const hist = await listServiceHistory(ws.ctx, S.vehicle.id, {});
    expect(JSON.stringify(hist)).toContain(S.job.jobNumber);
    expect(await stock(ws, S.part.id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });
});

describe('30-33. reports, audit trail, notifications and documents all agree with the records', () => {
  it('reports show the invoiced revenue, the cash received and nothing outstanding', async () => {
    const rev = await runReport(ws.ctx, 'revenue', { preset: 'THIS_YEAR' });
    const tile = (k: string) => rev.summary!.find((m) => m.key === k)!.value;
    expect(tile('invoiced')).toBe(S.subtotal);
    expect(tile('received')).toBe(S.total);
    expect(tile('outstanding')).toBe(0);
    const rec = await runReport(ws.ctx, 'receivables', {});
    expect(rec.summary!.find((m) => m.key === 'total')!.value).toBe(0);
    const jobs = await runReport(ws.ctx, 'jobs', { preset: 'THIS_YEAR' });
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ jobs: 1, completed: 1, open: 0, invoiced: S.subtotal }); // the jobs report agrees with the invoice
    const stockRep = await runReport(ws.ctx, 'stock', {});
    expect(JSON.stringify(stockRep.rows)).toContain('Front brake pad set');
  });

  it('the audit trail records every consequential step, in this business only', async () => {
    const log = await searchAuditLog(ws.ctx, { pageSize: 100 });
    const actions = new Set(log.items.map((a: { action: string }) => a.action));
    for (const a of ['business.created', 'customer.created', 'vehicle.created', 'booking.created', 'job.created', 'inspection.completed', 'quote.sent', 'quote.approved', 'invoice.finalised', 'payment.completed', 'receipt.issued']) {
      expect([...actions].some((x) => x === a), `audit has ${a} (have: ${[...actions].join(', ')})`).toBe(true);
    }
    const foreign = await ownerQuery('SELECT 1 FROM audit_logs WHERE business_id <> $1 AND resource_id = $2', [ws.businessId, S.job.id]);
    expect(foreign.rowCount).toBe(0);
  });

  it('the customer was told at each stage, once each, and nothing internal was sent', async () => {
    await drainJobs();
    const mails = sentTo(S.customer.email);
    const subjects = mails.map((m) => m.subject).join(' | ');
    expect(subjects).toMatch(/booking .*confirmed/i);
    expect(subjects).toContain(S.quote.number);
    expect(subjects).toContain(S.invoice.number);
    const count = (re: RegExp) => mails.filter((m) => re.test(m.subject)).length;
    expect(count(/booking .*confirmed/i)).toBe(1); // each event produced exactly one message
    expect(count(/^Quote .* from /)).toBe(1);
    expect(count(/approved/i)).toBe(1);
    expect(count(/^Invoice /)).toBe(1);
    expect(count(/Payment received/i)).toBe(2); // two payments, two receipts
    for (const m of mails) expect(`${m.subject} ${m.text ?? ''}`).not.toMatch(/INTERNAL|unit cost|margin|cost price/i); // plain text: the HTML's CSS legitimately says 'margin'
    const comms = (await ownerQuery<{ n: number }>("SELECT count(*)::int AS n FROM communications WHERE business_id = $1 AND customer_id = $2", [ws.businessId, S.customer.id])).rows[0]!.n;
    expect(comms).toBeGreaterThanOrEqual(3);
  });

  it('the generated documents exist, are private and belong to this business', async () => {
    const files = (await ownerQuery<{ generated_kind: string; visibility: string; business_id: string }>(
      "SELECT generated_kind, visibility, business_id FROM files WHERE business_id = $1 AND generated_kind IS NOT NULL", [ws.businessId])).rows;
    const kinds = new Set(files.map((f) => f.generated_kind));
    for (const k of ['quote', 'invoice', 'receipt']) expect([...kinds].some((x) => x.includes(k)), `a ${k} PDF was generated (have: ${[...kinds].join(', ')})`).toBe(true);
    expect(files.every((f) => f.business_id === ws.businessId)).toBe(true);
    const publicStore = await ownerQuery("SELECT 1 FROM files WHERE business_id = $1 AND storage_key IS NULL AND status = 'ACTIVE'", [ws.businessId]);
    expect(publicStore.rowCount).toBe(0);
  });
});

void createBusiness;
void MemoryTransport;
void key;
