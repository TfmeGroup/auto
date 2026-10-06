import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { assignTechnicians, changeJobStatus, createJob, getJobCard, addJobNote, setJobNoteVisibility } from '@/server/jobcards/service';
import {
  completeInspection, confirmDiagnosis, createDiagnosis, createRecommendedWork, decideRecommendedWork, listVehicleDiagnostics, removeRecommendedWork,
  startInspection, updateDiagnosis, updateInspectionItem, updateInspectionNotes, updateRecommendedWork,
} from '@/server/jobcards/work';
import { addJobLabour, addJobPart, addJobPhoto, removeJobPart, removeJobPhoto, setJobPhotoVisibility, updateJobPart } from '@/server/jobcards/items';
import { getInspectionReport } from '@/server/jobcards/reports';
import { getVehicleOverview, addInterval } from '@/server/vehicles/insights';
import { openFile } from '@/server/files/service';
import { createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { memberWithPermissions, seedCustomerVehicle } from '../helpers/workshop';
import { VALID_PNG } from '../helpers/images';

afterAll(disconnectPrisma);

const PNG = VALID_PNG;

let ws: TestWorkspace;
let tech: Awaited<ReturnType<typeof createMemberCtx>>;
let other: Awaited<ReturnType<typeof createMemberCtx>>;
let advisor: Awaited<ReturnType<typeof createMemberCtx>>;
let manager: Awaited<ReturnType<typeof createMemberCtx>>;

beforeAll(async () => {
  ws = await createWorkspace('Inspection Workshop');
  tech = await createMemberCtx(ws, 'technician');
  other = await createMemberCtx(ws, 'technician');
  advisor = await createMemberCtx(ws, 'service_advisor');
  manager = await createMemberCtx(ws, 'manager');
});

async function newJob(w = ws, assignTo: string | null = tech.ctx.membership.id) {
  const { customer, vehicle } = await seedCustomerVehicle(w, 'Ins');
  const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Grinding when braking', mileageKm: 50_100, primaryTechnicianMembershipId: assignTo ?? undefined });
  return { job, customer, vehicle };
}

const item = async (jobId: string, key: string) => {
  const card = await getJobCard(ws.ctx, jobId);
  return card.inspection!.items.find((i) => i.itemKey === key)!;
};

describe('digital vehicle inspection', () => {
  it('starts from the standard checklist, moves a checked-in job to Inspection, and is idempotent', async () => {
    const { job } = await newJob();
    const i = await startInspection(tech.ctx, job.id);
    expect(i).toMatchObject({ jobId: job.id, businessId: ws.businessId, status: 'IN_PROGRESS' });
    expect(i.technicianMembershipId).toBe(tech.ctx.membership.id);
    const card = await getJobCard(ws.ctx, job.id);
    expect(card.job.status).toBe('INSPECTION');
    const items = card.inspection!.items;
    expect(items).toHaveLength(18);
    for (const key of ['body', 'paint', 'windows', 'mirrors', 'lights', 'wipers', 'windscreen', 'visible_damage', 'tyre_condition', 'tread_condition', 'tyre_pressure', 'wheels_rims', 'engine', 'brakes', 'suspension', 'battery', 'fluids', 'belts_hoses']) {
      expect(items.some((x) => x.itemKey === key), key).toBe(true);
    }
    expect(new Set(items.map((x) => x.category))).toEqual(new Set(['EXTERIOR', 'TYRES_WHEELS', 'MECHANICAL']));
    expect(items.every((x) => x.status === 'NOT_CHECKED')).toBe(true);
    expect((await startInspection(tech.ctx, job.id)).id).toBe(i.id);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM inspections WHERE job_id = $1', [job.id])).rows[0]!.n).toBe(1);
  });

  it('records each item as Good, Attention or Critical, with notes and measurements, and photos are optional', async () => {
    const { job } = await newJob();
    await startInspection(tech.ctx, job.id);
    const brakes = await item(job.id, 'brakes');
    const after = await updateInspectionItem(tech.ctx, job.id, brakes.id, { status: 'CRITICAL', internalNotes: 'Pads at 1mm, scored discs', customerNotes: 'Your front brake pads are worn out' });
    expect(after).toMatchObject({ status: 'CRITICAL', updatedById: tech.ctx.user.id });
    const tread = await item(job.id, 'tread_condition');
    expect(await updateInspectionItem(tech.ctx, job.id, tread.id, { status: 'ATTENTION', measurement: '2.5', measurementUnit: 'mm' })).toMatchObject({ measurementTenths: 25, measurementUnit: 'mm' });
    await expect(updateInspectionItem(tech.ctx, job.id, brakes.id, { status: 'FINE' })).rejects.toMatchObject({ status: 422 });
    const done = await completeInspection(tech.ctx, job.id); // no photo anywhere, and most items unchecked: still fine
    expect(done).toMatchObject({ status: 'COMPLETED', completedById: tech.ctx.user.id });
    expect(done.completedAt).toBeInstanceOf(Date);
    const a = await ownerQuery("SELECT metadata FROM audit_logs WHERE action = 'inspection.completed' AND resource_id = $1", [done.id]);
    expect(a.rows[0]!.metadata).toMatchObject({ critical: 1, attention: 1 });
  });

  it('cannot be completed empty, and an item can only be changed inside its own job in its own business', async () => {
    const { job } = await newJob();
    await startInspection(tech.ctx, job.id);
    await expect(completeInspection(tech.ctx, job.id)).rejects.toMatchObject({ status: 409 });
    const { job: j2 } = await newJob();
    await startInspection(tech.ctx, j2.id);
    const foreignItem = await item(j2.id, 'engine');
    await expect(updateInspectionItem(tech.ctx, job.id, foreignItem.id, { status: 'GOOD' })).rejects.toMatchObject({ status: 404 }); // item of a different job

    const bws = await createWorkspace('Foreign Inspection Workshop');
    const b = await newJob(bws, null);
    await startInspection(bws.ctx, b.job.id);
    const bItem = (await getJobCard(bws.ctx, b.job.id)).inspection!.items[0]!;
    await expect(updateInspectionItem(ws.ctx, b.job.id, bItem.id, { status: 'GOOD' })).rejects.toMatchObject({ status: 404 }); // other business's job
    await expect(updateInspectionItem(ws.ctx, job.id, bItem.id, { status: 'GOOD' })).rejects.toMatchObject({ status: 404 }); // other business's item
    expect((await ownerQuery('SELECT status FROM inspection_items WHERE id = $1', [bItem.id])).rows[0]!.status).toBe('NOT_CHECKED');
    // and the database refuses to attach an inspection to a job of another customer/vehicle combination
    await expect(ownerQuery('INSERT INTO inspections (business_id, job_id, vehicle_id, customer_id, updated_at) VALUES ($1, $2, $3, $4, now())', [ws.businessId, j2.id, b.vehicle.id, b.customer.id])).rejects.toThrow();
  });

  it('technicians only inspect the jobs they are assigned to', async () => {
    const { job } = await newJob();
    await expect(startInspection(other.ctx, job.id)).rejects.toMatchObject({ status: 403 });
    await expect(startInspection(advisor.ctx, job.id)).rejects.toMatchObject({ status: 403 }); // advisors do not record inspections
    expect((await startInspection(manager.ctx, job.id)).jobId).toBe(job.id);
  });
});

describe('diagnosis and recommended work stay distinct', () => {
  it('findings are observations; the diagnosis is a separate statement that only counts once confirmed', async () => {
    const { job } = await newJob();
    const d = await createDiagnosis(tech.ctx, job.id, { symptoms: 'Squeal when braking', faultCodes: ['p0301', 'U0100'], testsPerformed: 'Road test, scan', findings: 'Front pads 1mm; rear fine' });
    expect(d).toMatchObject({ faultCodes: ['P0301', 'U0100'], diagnosis: null, confirmedAt: null });
    await expect(confirmDiagnosis(tech.ctx, job.id, d.id)).rejects.toMatchObject({ status: 422, details: { diagnosis: expect.stringContaining('observations') } });
    const stated = await updateDiagnosis(tech.ctx, job.id, d.id, { diagnosis: 'Front brake pads worn beyond limit' });
    expect(stated.confirmedAt).toBeNull(); // writing it down is not confirming it
    const confirmed = await confirmDiagnosis(tech.ctx, job.id, d.id);
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    expect(confirmed.confirmedById).toBe(tech.ctx.user.id);
    const changed = await updateDiagnosis(tech.ctx, job.id, d.id, { diagnosis: 'Front pads and discs worn' });
    expect(changed.confirmedAt).toBeNull(); // changing the conclusion withdraws the confirmation
    await expect(createDiagnosis(tech.ctx, job.id, { faultCodes: ['not a code!'] })).rejects.toMatchObject({ status: 422 });
    await expect(createDiagnosis(tech.ctx, job.id, {})).rejects.toMatchObject({ status: 422 });
    const diag = await listVehicleDiagnostics(ws.ctx, (await getJobCard(ws.ctx, job.id)).job.vehicleId);
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ jobNumber: job.jobNumber, technicianName: expect.any(String) });
  });

  it('a diagnosis or a critical finding never creates or approves a repair by itself', async () => {
    const { job } = await newJob();
    await startInspection(tech.ctx, job.id);
    await updateInspectionItem(tech.ctx, job.id, (await item(job.id, 'brakes')).id, { status: 'CRITICAL' });
    const d = await createDiagnosis(tech.ctx, job.id, { findings: 'Pads worn', diagnosis: 'Pads worn out' });
    await confirmDiagnosis(tech.ctx, job.id, d.id);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM recommended_work_items WHERE job_id = $1', [job.id])).rows[0]!.n).toBe(0);
    expect((await getJobCard(ws.ctx, job.id)).recommendedWork).toEqual([]);
  });

  it('recommended work is its own record, linked to its source, and always starts un-approved', async () => {
    const { job } = await newJob();
    await startInspection(tech.ctx, job.id);
    const brakes = await item(job.id, 'brakes');
    await updateInspectionItem(tech.ctx, job.id, brakes.id, { status: 'CRITICAL' });
    const w = await createRecommendedWork(tech.ctx, job.id, {
      description: 'Replace front brake pads', priority: 'URGENT', quantity: 1, partsDescription: 'Front pad set', estimatedMinutes: 90, notes: 'Check discs', sourceInspectionItemId: brakes.id,
    });
    expect(w).toMatchObject({ sourceType: 'INSPECTION_ITEM', sourceInspectionItemId: brakes.id, priority: 'URGENT', approvalStatus: 'PENDING', decidedAt: null, estimatedMinutes: 90 });
    await expect(createRecommendedWork(tech.ctx, job.id, { description: 'x', priority: 'WHENEVER' })).rejects.toMatchObject({ status: 422 });
    const { job: j2 } = await newJob();
    await expect(createRecommendedWork(tech.ctx, j2.id, { description: 'x', sourceInspectionItemId: brakes.id })).rejects.toMatchObject({ status: 422 }); // finding belongs to another job
    const diag = await createDiagnosis(tech.ctx, job.id, { findings: 'f' });
    expect(await createRecommendedWork(tech.ctx, job.id, { description: 'From diagnosis', sourceDiagnosisId: diag.id })).toMatchObject({ sourceType: 'DIAGNOSIS', sourceDiagnosisId: diag.id });
    expect(await createRecommendedWork(tech.ctx, job.id, { description: 'Manual' })).toMatchObject({ sourceType: 'MANUAL' });
  });

  it('only people who record customer approval can decide, they must say how, and editing approved work withdraws the decision', async () => {
    const { job } = await newJob();
    const w = await createRecommendedWork(tech.ctx, job.id, { description: 'Replace pads', priority: 'IMPORTANT' });
    await changeJobStatus(ws.ctx, job.id, { status: 'INSPECTION' });
    await changeJobStatus(ws.ctx, job.id, { status: 'DIAGNOSIS' });
    await changeJobStatus(ws.ctx, job.id, { status: 'AWAITING_APPROVAL' });
    await expect(decideRecommendedWork(tech.ctx, job.id, w.id, { decision: 'APPROVED', method: 'IN_PERSON' })).rejects.toMatchObject({ status: 403 });
    await expect(decideRecommendedWork(advisor.ctx, job.id, w.id, { decision: 'APPROVED' })).rejects.toMatchObject({ status: 422 });
    const ok = await decideRecommendedWork(advisor.ctx, job.id, w.id, { decision: 'APPROVED', method: 'PHONE', note: 'Mr Dlamini called' });
    expect(ok).toMatchObject({ approvalStatus: 'APPROVED', approvalMethod: 'PHONE', decidedById: advisor.ctx.user.id, decisionNote: 'Mr Dlamini called' });
    const a = await ownerQuery("SELECT user_id, metadata FROM audit_logs WHERE action = 'recommended_work.decision' AND resource_id = $1", [w.id]);
    expect(a.rows[0]).toMatchObject({ user_id: advisor.ctx.user.id });
    // a note edit keeps the decision; changing what the work is withdraws it
    expect((await updateRecommendedWork(tech.ctx, job.id, w.id, { notes: 'Use OEM' })).approvalStatus).toBe('APPROVED');
    expect(await updateRecommendedWork(tech.ctx, job.id, w.id, { description: 'Replace pads AND discs', priority: 'URGENT' })).toMatchObject({ approvalStatus: 'PENDING', decidedAt: null, approvalMethod: null });
    await removeRecommendedWork(tech.ctx, job.id, w.id);
    expect((await getJobCard(ws.ctx, job.id)).recommendedWork).toEqual([]);
    expect((await ownerQuery('SELECT archived_at FROM recommended_work_items WHERE id = $1', [w.id])).rows[0]!.archived_at).toBeInstanceOf(Date); // archived, not erased
  });

  it('decisions can only be recorded once the job is waiting for approval', async () => {
    const { job } = await newJob();
    const w = await createRecommendedWork(tech.ctx, job.id, { description: 'Replace pads' });
    await expect(decideRecommendedWork(advisor.ctx, job.id, w.id, { decision: 'APPROVED', method: 'IN_PERSON' })).rejects.toMatchObject({ status: 409 });
  });

  it('prices are only entered and seen by people allowed to see job pricing', async () => {
    const { job } = await newJob();
    await expect(createRecommendedWork(tech.ctx, job.id, { description: 'Pads', estimatedLabourCents: 45_000 })).rejects.toMatchObject({ status: 403 });
    const w = await createRecommendedWork(manager.ctx, job.id, { description: 'Pads', estimatedLabourCents: 45_000, estimatedPartsCents: 120_000 });
    const asTech = (await getJobCard(tech.ctx, job.id)).recommendedWork[0]!;
    expect(asTech).toMatchObject({ id: w.id, estimatedLabourCents: null, estimatedPartsCents: null });
    expect((await getJobCard(tech.ctx, job.id)).total).toBeNull();
    const asManager = await getJobCard(manager.ctx, job.id);
    expect(asManager.recommendedWork[0]).toMatchObject({ estimatedLabourCents: 45_000, estimatedPartsCents: 120_000 });
    expect(asManager.total).toMatchObject({ recommendedCents: 165_000 });
  });
});

describe('internal vs customer-visible information', () => {
  it('the customer report contains only what was marked for the customer; the internal one has everything', async () => {
    const { job } = await newJob();
    await startInspection(tech.ctx, job.id);
    const brakes = await item(job.id, 'brakes');
    const engine = await item(job.id, 'engine');
    const battery = await item(job.id, 'battery');
    await updateInspectionItem(tech.ctx, job.id, brakes.id, { status: 'CRITICAL', internalNotes: 'SECRET-ITEM-NOTE customer lied about warranty', customerNotes: 'Pads are worn out' });
    await updateInspectionItem(tech.ctx, job.id, engine.id, { status: 'ATTENTION', internalNotes: 'SECRET-ENGINE', customerVisible: false });
    await updateInspectionItem(tech.ctx, job.id, battery.id, { status: 'GOOD', measurement: '12.6', measurementUnit: 'V' });
    await updateInspectionNotes(tech.ctx, job.id, { internalNotes: 'SECRET-INSPECTION-NOTE', customerSummary: 'Brakes need urgent attention' });
    await createDiagnosis(tech.ctx, job.id, { symptoms: 'SECRET-SYMPTOM', faultCodes: ['P0420'], findings: 'SECRET-FINDING', diagnosis: 'SECRET-CONCLUSION', internalNotes: 'SECRET-DIAG-NOTE', customerSummary: 'We found worn brake parts' });
    await createRecommendedWork(tech.ctx, job.id, { description: 'Replace front brake pads', priority: 'URGENT', notes: 'SECRET-WORK-NOTE', sourceInspectionItemId: brakes.id });
    await createRecommendedWork(tech.ctx, job.id, { description: 'Internal-only check of loom', customerVisible: false });
    await addJobNote(tech.ctx, job.id, { body: 'SECRET-NOTE-INTERNAL' });
    await addJobNote(tech.ctx, job.id, { body: 'Your car is in the workshop', visibility: 'CUSTOMER' });
    const internalPhoto = await addJobPhoto(tech.ctx, job.id, { data: PNG, filename: 'a.png' }, { category: 'DAMAGED_COMPONENT', description: 'SECRET-PHOTO-DESC', inspectionItemId: brakes.id });
    const sharedPhoto = await addJobPhoto(tech.ctx, job.id, { data: PNG, filename: 'b.png' }, { category: 'DAMAGED_COMPONENT', visibility: 'CUSTOMER', description: 'Worn pad', inspectionItemId: brakes.id });
    await completeInspection(tech.ctx, job.id);

    const customer = await getInspectionReport(ws.ctx, job.id, { audience: 'customer' });
    const text = JSON.stringify(customer);
    expect(text).not.toMatch(/SECRET/);
    expect(text).not.toMatch(/P0420/);
    expect(text).not.toContain(internalPhoto.fileId);
    expect(text).toContain(sharedPhoto.fileId);
    expect(text).toContain('Pads are worn out');
    expect(text).toContain('Brakes need urgent attention');
    expect(text).toContain('We found worn brake parts');
    expect(text).toContain('Your car is in the workshop');
    expect(text).not.toContain('Internal-only check of loom');
    expect(text).not.toContain('"Engine"'); // item flagged not for the customer
    const labels = customer.inspection.sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toEqual(expect.arrayContaining(['Brakes', 'Battery']));
    expect(labels).not.toContain('Fluids'); // never checked, so not shown
    expect(customer.inspection.sections.flatMap((s) => s.items).find((i) => i.label === 'Battery')!.measurement).toEqual({ value: 12.6, unit: 'V' });
    expect(customer.inspection.totals).toMatchObject({ critical: 1, good: 1 });
    expect(customer.recommendedWork).toHaveLength(1);
    expect(customer.customer.name).toBeTruthy();
    expect(customer.vehicle.registration).toBeTruthy();
    expect(customer.business.name).toBe('Inspection Workshop');
    expect(customer.inspection.technician).toBeTruthy();

    const internal = await getInspectionReport(ws.ctx, job.id, { audience: 'internal' });
    const itext = JSON.stringify(internal);
    for (const s of ['SECRET-ITEM-NOTE', 'SECRET-ENGINE', 'SECRET-INSPECTION-NOTE', 'SECRET-SYMPTOM', 'SECRET-FINDING', 'SECRET-CONCLUSION', 'SECRET-DIAG-NOTE', 'SECRET-WORK-NOTE', 'SECRET-NOTE-INTERNAL', 'SECRET-PHOTO-DESC', 'P0420']) expect(itext, s).toContain(s);
  });

  it('changing a photo or note between internal and customer-visible is audited, and removed photos are archived not erased', async () => {
    const { job } = await newJob();
    const photo = await addJobPhoto(tech.ctx, job.id, { data: PNG, filename: 'c.png' }, { category: 'BEFORE_REPAIR' });
    expect(photo).toMatchObject({ businessId: ws.businessId, jobId: job.id, visibility: 'INTERNAL', uploadedById: tech.ctx.user.id, category: 'BEFORE_REPAIR' });
    expect(photo.vehicleId).toBe((await getJobCard(ws.ctx, job.id)).job.vehicleId);
    expect(photo.createdAt).toBeInstanceOf(Date);
    await setJobPhotoVisibility(tech.ctx, job.id, photo.id, 'CUSTOMER');
    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE action = 'job.photo_visibility_changed' AND resource_id = $1", [job.id]);
    expect(a.rows[0]).toMatchObject({ before: { visibility: 'INTERNAL' }, after: { visibility: 'CUSTOMER' } });
    const note = await addJobNote(tech.ctx, job.id, { body: 'hello' });
    await setJobNoteVisibility(tech.ctx, job.id, note.id, 'CUSTOMER');
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'job.note_visibility_changed' AND resource_id = $1", [job.id])).rows[0]!.n).toBe(1);

    await expect(removeJobPhoto(tech.ctx, job.id, photo.id)).rejects.toMatchObject({ status: 403 }); // technicians cannot delete documents
    await removeJobPhoto(manager.ctx, job.id, photo.id);
    expect((await ownerQuery('SELECT archived_at FROM job_photos WHERE id = $1', [photo.id])).rows[0]!.archived_at).toBeInstanceOf(Date);
    expect((await ownerQuery('SELECT status FROM files WHERE id = $1', [photo.fileId])).rows[0]!.status).toBe('ARCHIVED');
    expect((await getJobCard(ws.ctx, job.id)).photos).toHaveLength(0);
  });

  it('job photos are private to people who may see the job', async () => {
    const { job } = await newJob();
    const photo = await addJobPhoto(tech.ctx, job.id, { data: PNG, filename: 'd.png' }, {});
    const docsOnly = await memberWithPermissions(ws, ['document.view']);
    await expect(openFile(docsOnly.ctx, photo.fileId)).rejects.toMatchObject({ status: 403 });
    expect((await openFile(tech.ctx, photo.fileId)).file.id).toBe(photo.fileId);
    const bws = await createWorkspace('Peeking Workshop');
    await expect(openFile(bws.ctx, photo.fileId)).rejects.toMatchObject({ status: 404 });
    await expect(addJobPhoto(bws.ctx, job.id, { data: PNG, filename: 'e.png' }, {})).rejects.toMatchObject({ status: 404 });
    await expect(addJobPhoto(other.ctx, job.id, { data: PNG, filename: 'f.png' }, {})).rejects.toMatchObject({ status: 403 }); // not assigned
    await expect(addJobPhoto(tech.ctx, job.id, { data: Buffer.from('not an image at all'), filename: 'x.png' }, {})).rejects.toMatchObject({ status: 415 });
  });
});

describe('vehicle health indicator', () => {
  const health = async (vehicleId: string) => (await getVehicleOverview(ws.ctx, vehicleId)).health!;

  it('is Good when nothing is recorded, Immediate Attention for an unresolved critical finding, and Good again once that work is done', async () => {
    const { job, vehicle } = await newJob();
    expect((await health(vehicle.id)).level).toBe('GOOD');
    await startInspection(tech.ctx, job.id);
    const brakes = await item(job.id, 'brakes');
    await updateInspectionItem(tech.ctx, job.id, brakes.id, { status: 'CRITICAL' });
    await completeInspection(tech.ctx, job.id);
    const h = await health(vehicle.id);
    expect(h.level).toBe('IMMEDIATE_ATTENTION');
    expect(h.facts.map((f) => f.text)).toContain('Inspection: Brakes recorded as critical');

    const w = await createRecommendedWork(tech.ctx, job.id, { description: 'Replace pads', priority: 'URGENT', sourceInspectionItemId: brakes.id });
    expect((await health(vehicle.id)).outstandingWork.map((x) => x.id)).toEqual([w.id]);
    for (const s of ['DIAGNOSIS', 'AWAITING_APPROVAL'] as const) await changeJobStatus(ws.ctx, job.id, { status: s });
    await decideRecommendedWork(ws.ctx, job.id, w.id, { decision: 'APPROVED', method: 'IN_PERSON' });
    for (const s of ['APPROVED', 'IN_PROGRESS', 'QUALITY_CHECK'] as const) await changeJobStatus(ws.ctx, job.id, { status: s });
    await changeJobStatus(ws.ctx, job.id, { status: 'READY_FOR_COLLECTION', override: true, reason: 'Test shortcut' });
    await changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED' });
    expect((await health(vehicle.id)).level).toBe('GOOD'); // the critical finding's work was done
  });

  it('declined urgent work is still outstanding; attention items and overdue servicing give Attention Recommended', async () => {
    const { job, vehicle } = await newJob();
    await createRecommendedWork(tech.ctx, job.id, { description: 'Replace tyres', priority: 'URGENT' });
    for (const s of ['INSPECTION', 'DIAGNOSIS', 'AWAITING_APPROVAL'] as const) await changeJobStatus(ws.ctx, job.id, { status: s });
    const w = (await getJobCard(ws.ctx, job.id)).recommendedWork[0]!;
    await decideRecommendedWork(ws.ctx, job.id, w.id, { decision: 'DECLINED', method: 'PHONE' });
    expect((await health(vehicle.id)).level).toBe('IMMEDIATE_ATTENTION');
    await removeRecommendedWork(ws.ctx, job.id, w.id);
    expect((await health(vehicle.id)).level).toBe('GOOD');
    await addInterval(ws.ctx, vehicle.id, { name: 'Oil service', everyKm: 10_000, lastServiceKm: 30_000 });
    const h = await health(vehicle.id);
    expect(h.level).toBe('ATTENTION_RECOMMENDED');
    expect(h.facts[0]!.text).toContain('Oil service is overdue');
  });

  it('is only shown to people who may see jobs', async () => {
    const { vehicle } = await newJob();
    const onlyVehicles = await memberWithPermissions(ws, ['vehicle.view']);
    const o = await getVehicleOverview(onlyVehicles.ctx, vehicle.id);
    expect(o.health).toBeNull();
    expect(o.totalJobs).toBeNull();
  });
});

describe('parts and labour on a job (foundation for Part 5)', () => {
  it('records parts and labour; costs, prices and rates are limited to people who may see pricing', async () => {
    const { job } = await newJob();
    const p = await addJobPart(tech.ctx, job.id, { description: 'Front pad set', partNumber: 'BP-1234', quantity: 1, status: 'REQUESTED' });
    expect(p).toMatchObject({ costCents: null, sellPriceCents: null, inventoryItemId: null, status: 'REQUESTED', businessId: ws.businessId });
    await expect(addJobPart(tech.ctx, job.id, { description: 'Discs', sellPriceCents: 90_000 })).rejects.toMatchObject({ status: 403 });
    await expect(addJobLabour(tech.ctx, job.id, { description: 'Fit pads', minutes: 90, rateCentsPerHour: 45_000 })).rejects.toMatchObject({ status: 403 });
    const l1 = await addJobLabour(tech.ctx, job.id, { description: 'Removed wheels', minutes: 20 });
    expect(l1).toMatchObject({ technicianMembershipId: tech.ctx.membership.id, totalCents: null });
    const l2 = await addJobLabour(manager.ctx, job.id, { description: 'Fit pads', minutes: 90, rateCentsPerHour: 45_000, technicianMembershipId: tech.ctx.membership.id });
    expect(l2.totalCents).toBe(67_500);
    const pm = await addJobPart(manager.ctx, job.id, { description: 'Discs', quantity: 2, costCents: 40_000, sellPriceCents: 60_000 });
    await updateJobPart(manager.ctx, job.id, pm.id, { status: 'FITTED' });
    await expect(addJobLabour(manager.ctx, job.id, { description: 'bad', minutes: 0 })).rejects.toMatchObject({ status: 422 });

    const asTech = await getJobCard(tech.ctx, job.id);
    expect(asTech.parts.every((x) => x.costCents === null && x.sellPriceCents === null)).toBe(true);
    expect(asTech.labour.every((x) => x.rateCentsPerHour === null && x.totalCents === null)).toBe(true);
    expect(asTech.total).toBeNull();
    const asMgr = await getJobCard(manager.ctx, job.id);
    expect(asMgr.total).toMatchObject({ partsCents: 120_000, labourCents: 67_500 });
    expect(asMgr.parts.find((x) => x.id === pm.id)).toMatchObject({ costCents: 40_000, status: 'FITTED' });

    await removeJobPart(tech.ctx, job.id, p.id);
    expect((await getJobCard(ws.ctx, job.id)).parts.map((x) => x.id)).toEqual([pm.id]);
    expect((await ownerQuery('SELECT archived_at FROM job_parts WHERE id = $1', [p.id])).rows[0]!.archived_at).toBeInstanceOf(Date);
  });

  it('cannot be added to a job in another business or one that is not assigned to the technician', async () => {
    const { job } = await newJob();
    const bws = await createWorkspace('Parts Foreign Workshop');
    await expect(addJobPart(bws.ctx, job.id, { description: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(addJobPart(other.ctx, job.id, { description: 'x' })).rejects.toMatchObject({ status: 403 });
    await assignTechnicians(ws.ctx, job.id, { primaryTechnicianMembershipId: other.ctx.membership.id });
    await expect(addJobPart(other.ctx, job.id, { description: 'x' })).resolves.toBeTruthy();
  });
});
