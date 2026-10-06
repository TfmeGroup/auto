import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { createBooking } from '@/server/bookings/service';
import {
  assignTechnicians, changeJobStatus, checkInBooking, createJob, getJobCard, listJobs, listMyJobs, recordQualityCheck, updateJob,
} from '@/server/jobcards/service';
import { createRecommendedWork, decideRecommendedWork } from '@/server/jobcards/work';
import { addJobNote, setJobNoteVisibility } from '@/server/jobcards/service';
import { addInterval, listIntervals, listServiceHistory } from '@/server/vehicles/insights';
import { getVehicle } from '@/server/vehicles/service';
import { listServiceTypes } from '@/server/workshop/service';
import { listTimeline } from '@/server/activity/service';
import type { JobStatus } from '@/server/jobcards/transitions';
import { createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { nextWeekday, seedCustomerVehicle } from '../helpers/workshop';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
let tech: Awaited<ReturnType<typeof createMemberCtx>>;
let otherTech: Awaited<ReturnType<typeof createMemberCtx>>;
let advisor: Awaited<ReturnType<typeof createMemberCtx>>;
let manager: Awaited<ReturnType<typeof createMemberCtx>>;

beforeAll(async () => {
  ws = await createWorkspace('Jobs Workshop');
  tech = await createMemberCtx(ws, 'technician');
  otherTech = await createMemberCtx(ws, 'technician');
  advisor = await createMemberCtx(ws, 'service_advisor');
  manager = await createMemberCtx(ws, 'manager');
});

/** Open a job and drive it to the given status with the owner's authority. */
async function jobAt(target: JobStatus, over: Record<string, unknown> = {}, w = ws) {
  const { customer, vehicle } = await seedCustomerVehicle(w, 'Job');
  const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Knocking noise', mileageKm: 50_100, ...over });
  const steps: [JobStatus, (() => Promise<unknown>)?][] = [
    ['CHECKED_IN'], ['INSPECTION'], ['DIAGNOSIS'],
    ['AWAITING_APPROVAL', async () => createRecommendedWork(w.ctx, job.id, { description: 'Replace front brake pads', priority: 'URGENT' })],
    ['APPROVED', async () => {
      const work = (await getJobCard(w.ctx, job.id)).recommendedWork;
      for (const x of work) await decideRecommendedWork(w.ctx, job.id, x.id, { decision: 'APPROVED', method: 'IN_PERSON' });
    }],
    ['IN_PROGRESS'], ['QUALITY_CHECK'],
  ];
  for (const [status, before] of steps) {
    if (status === 'CHECKED_IN') continue;
    if ((await ownerQuery('SELECT status FROM job_cards WHERE id = $1', [job.id])).rows[0]!.status === target) break;
    if (before) await before();
    await changeJobStatus(w.ctx, job.id, { status });
  }
  return { job, customer, vehicle };
}

const status = async (id: string) => (await ownerQuery('SELECT status FROM job_cards WHERE id = $1', [id])).rows[0]!.status as string;

describe('the status workflow', () => {
  it('walks a job from check-in to completion, recording each step', async () => {
    const { job, vehicle } = await jobAt('QUALITY_CHECK');
    expect(await status(job.id)).toBe('QUALITY_CHECK');
    await recordQualityCheck(ws.ctx, job.id, { passed: true, checklist: { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: true, requested_work_completed: true } });
    expect(await status(job.id)).toBe('READY_FOR_COLLECTION');
    const done = await changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED', mileageOutKm: 50_130, completionSummary: 'Pads and discs replaced' });
    expect(done).toMatchObject({ status: 'COMPLETED', mileageOutKm: 50_130, completionSummary: 'Pads and discs replaced', completedById: ws.ctx.user.id });
    expect(done.completedAt).toBeInstanceOf(Date);
    expect((await getVehicle(ws.ctx, vehicle.id)).mileageKm).toBe(50_130);
    const tl = (await listTimeline(ws.ctx, { jobId: job.id }, { pageSize: 100 })).items.filter((e) => e.type === 'job.status_changed').map((e) => e.summary);
    expect(tl.length).toBeGreaterThanOrEqual(8);
    const audits = await ownerQuery("SELECT before, after FROM audit_logs WHERE resource_id = $1 AND action = 'job.status_changed' ORDER BY created_at", [job.id]);
    expect(audits.rows.at(0)!.after).toMatchObject({ status: 'INSPECTION' });
    expect(audits.rows.at(-1)!.after).toMatchObject({ status: 'COMPLETED' });
  });

  it('refuses impossible transitions without an override, and explains why', async () => {
    const { job } = await jobAt('CHECKED_IN');
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED' })).rejects.toMatchObject({ status: 409 });
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Inspection') });
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'BOOKED' })).rejects.toMatchObject({ status: 409 });
    expect(await status(job.id)).toBe('CHECKED_IN');
  });

  it('only people with the right permission can make each kind of change', async () => {
    const { job } = await jobAt('CHECKED_IN');
    await assignTechnicians(ws.ctx, job.id, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    // An assigned technician can move the job along…
    expect((await changeJobStatus(tech.ctx, job.id, { status: 'INSPECTION' })).status).toBe('INSPECTION');
    // …but not one that is not theirs, and not cancel or complete.
    await expect(changeJobStatus(otherTech.ctx, job.id, { status: 'DIAGNOSIS' })).rejects.toMatchObject({ status: 403 });
    await expect(changeJobStatus(tech.ctx, job.id, { status: 'CANCELLED', reason: 'x' })).rejects.toMatchObject({ status: 403 });
    // Skipping the workflow is for people who may override it.
    await expect(changeJobStatus(tech.ctx, job.id, { status: 'COMPLETED', override: true, reason: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(changeJobStatus(advisor.ctx, job.id, { status: 'COMPLETED', override: true, reason: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(await status(job.id)).toBe('INSPECTION');
  });

  it('a manager can override the workflow, but must say why; overrides are audited as such', async () => {
    const { job } = await jobAt('CHECKED_IN');
    await expect(changeJobStatus(manager.ctx, job.id, { status: 'IN_PROGRESS', override: true })).rejects.toMatchObject({ status: 422 });
    const r = await changeJobStatus(manager.ctx, job.id, { status: 'IN_PROGRESS', override: true, reason: 'Customer waiting, inspection done verbally' });
    expect(r.status).toBe('IN_PROGRESS');
    const a = await ownerQuery("SELECT action, metadata FROM audit_logs WHERE resource_id = $1 AND action = 'job.status_overridden'", [job.id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.metadata).toMatchObject({ reason: 'Customer waiting, inspection done verbally' });
  });

  it('two people changing the same job at once: one change is applied, the other is told it was already changed', async () => {
    const { job } = await jobAt('CHECKED_IN');
    const results = await Promise.allSettled([
      changeJobStatus(ws.ctx, job.id, { status: 'INSPECTION', expectedStatus: 'CHECKED_IN' }),
      changeJobStatus(manager.ctx, job.id, { status: 'INSPECTION', expectedStatus: 'CHECKED_IN' }),
      changeJobStatus(advisor.ctx, job.id, { status: 'INSPECTION', expectedStatus: 'CHECKED_IN' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND action = 'job.status_changed'", [job.id])).rows[0]!.n).toBe(1);
    // a stale screen is refused outright
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'DIAGNOSIS', expectedStatus: 'CHECKED_IN' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('someone else') });
  });

  it('asking for approval needs recommended work; approving needs every item decided and at least one approved', async () => {
    const { job } = await jobAt('DIAGNOSIS');
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'AWAITING_APPROVAL' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('recommended work') });
    const a = await createRecommendedWork(ws.ctx, job.id, { description: 'Replace pads', priority: 'URGENT' });
    const b = await createRecommendedWork(ws.ctx, job.id, { description: 'Rotate tyres', priority: 'RECOMMENDED' });
    await changeJobStatus(ws.ctx, job.id, { status: 'AWAITING_APPROVAL' });
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'APPROVED' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('waiting for a decision') });
    await decideRecommendedWork(ws.ctx, job.id, a.id, { decision: 'DECLINED', method: 'PHONE' });
    await decideRecommendedWork(ws.ctx, job.id, b.id, { decision: 'DECLINED', method: 'PHONE' });
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'APPROVED' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('declined') });
    await decideRecommendedWork(ws.ctx, job.id, a.id, { decision: 'APPROVED', method: 'PHONE', note: 'Approved by phone, Mr Dlamini' });
    expect((await changeJobStatus(ws.ctx, job.id, { status: 'APPROVED' })).status).toBe('APPROVED');
  });

  it('cancelling and holding need a reason; a held job resumes where it stopped', async () => {
    const { job } = await jobAt('IN_PROGRESS');
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'ON_HOLD' })).rejects.toMatchObject({ status: 422 });
    expect((await changeJobStatus(ws.ctx, job.id, { status: 'ON_HOLD', reason: 'Waiting for customer' })).heldFromStatus).toBe('IN_PROGRESS');
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'QUALITY_CHECK' })).rejects.toMatchObject({ status: 409 });
    expect((await changeJobStatus(ws.ctx, job.id, { status: 'IN_PROGRESS' })).heldFromStatus).toBeNull();
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'CANCELLED' })).rejects.toMatchObject({ status: 422 });
    const cancelled = await changeJobStatus(manager.ctx, job.id, { status: 'CANCELLED', reason: 'Customer collected the car unrepaired' });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer collected the car unrepaired' });
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ status: 409 });
    await expect(addJobNote(ws.ctx, job.id, { body: 'late note' })).resolves.toBeTruthy(); // notes may still be added to a closed job
    await expect(updateJob(ws.ctx, job.id, { complaint: 'x' })).rejects.toMatchObject({ status: 409 }); // but details are frozen
  });

  it('the vehicle’s workshop status follows the job by explicit rules and records why; INACTIVE is never touched', async () => {
    const { job, vehicle } = await jobAt('DIAGNOSIS');
    expect((await getVehicle(ws.ctx, vehicle.id)).status).toBe('IN_WORKSHOP');
    await createRecommendedWork(ws.ctx, job.id, { description: 'Replace pads' });
    await changeJobStatus(ws.ctx, job.id, { status: 'AWAITING_APPROVAL' });
    expect((await getVehicle(ws.ctx, vehicle.id)).status).toBe('REPAIR_REQUIRED');
    const tl = (await listTimeline(ws.ctx, { vehicleId: vehicle.id }, {})).items.filter((e) => e.type === 'vehicle.status_changed');
    expect(tl.some((e) => /Job JOB-\d+ is awaiting approval/.test(e.summary))).toBe(true);
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE resource_id = $1 AND action = 'vehicle.status_changed' ORDER BY created_at DESC LIMIT 1", [vehicle.id]);
    expect(audit.rows[0]!.metadata).toMatchObject({ source: 'job_workflow', jobId: job.id });
    await changeJobStatus(ws.ctx, job.id, { status: 'CANCELLED', reason: 'Not proceeding' });
    expect((await getVehicle(ws.ctx, vehicle.id)).status).toBe('ACTIVE');

    const inactive = await jobAt('CHECKED_IN');
    await ownerQuery("UPDATE vehicles SET status = 'INACTIVE' WHERE id = $1", [inactive.vehicle.id]);
    await changeJobStatus(ws.ctx, inactive.job.id, { status: 'INSPECTION' });
    expect((await getVehicle(ws.ctx, inactive.vehicle.id)).status).toBe('INACTIVE');
  });
});

describe('quality check', () => {
  const all = { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: true, requested_work_completed: true };

  it('a pass needs every item and sends the job to Ready for Collection', async () => {
    const { job } = await jobAt('QUALITY_CHECK');
    await expect(recordQualityCheck(ws.ctx, job.id, { passed: true, checklist: { ...all, tools_removed: false } })).rejects.toMatchObject({ status: 422, details: { checklist: expect.stringContaining('Tools removed') } });
    expect(await status(job.id)).toBe('QUALITY_CHECK');
    const r = await recordQualityCheck(ws.ctx, job.id, { passed: true, checklist: { ...all, test_drive: 'na' }, notes: 'Road tested not required' });
    expect(r.status).toBe('READY_FOR_COLLECTION');
    const rows = await ownerQuery('SELECT passed, checked_by_id, created_at, checklist FROM job_quality_checks WHERE job_id = $1', [job.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ passed: true, checked_by_id: ws.ctx.user.id });
  });

  it('a fail needs a reason, records who/when/why/notes, and returns the job to In Progress; the failure stays in history', async () => {
    const { job } = await jobAt('QUALITY_CHECK');
    await expect(recordQualityCheck(ws.ctx, job.id, { passed: false, checklist: { ...all, work_completed: false } })).rejects.toMatchObject({ status: 422, details: { reason: expect.any(String) } });
    const r = await recordQualityCheck(manager.ctx, job.id, { passed: false, checklist: { ...all, parts_installed: false }, reason: 'Brake fluid not topped up', notes: 'Re-check after bleeding' });
    expect(r.status).toBe('IN_PROGRESS');
    const rows = (await ownerQuery('SELECT * FROM job_quality_checks WHERE job_id = $1', [job.id])).rows;
    expect(rows[0]).toMatchObject({ passed: false, reason: 'Brake fluid not topped up', notes: 'Re-check after bleeding', checked_by_id: manager.ctx.user.id });
    expect(rows[0]!.created_at).toBeInstanceOf(Date);
    // second round passes; the earlier failure is still there
    await changeJobStatus(ws.ctx, job.id, { status: 'QUALITY_CHECK' });
    await recordQualityCheck(ws.ctx, job.id, { passed: true, checklist: all });
    expect((await ownerQuery('SELECT passed FROM job_quality_checks WHERE job_id = $1 ORDER BY created_at', [job.id])).rows.map((r) => r.passed)).toEqual([false, true]);
    expect((await getJobCard(ws.ctx, job.id)).qualityChecks).toHaveLength(2);
    // the audit trail is append-only at the database
    await expect(ownerQuery('DELETE FROM job_quality_checks WHERE job_id = $1', [job.id])).rejects.toThrow(/append-only/);
  });

  it('the status endpoint cannot be used to skip the quality check; only a user with the permission may record it; it only applies in Quality Check', async () => {
    const { job } = await jobAt('QUALITY_CHECK');
    await expect(changeJobStatus(ws.ctx, job.id, { status: 'READY_FOR_COLLECTION' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('quality check') });
    await expect(recordQualityCheck(tech.ctx, job.id, { passed: true, checklist: all })).rejects.toMatchObject({ status: 403 });
    const early = await jobAt('IN_PROGRESS');
    await expect(recordQualityCheck(ws.ctx, early.job.id, { passed: true, checklist: all })).rejects.toMatchObject({ status: 409 });
  });
});

describe('completion, service history and intervals', () => {
  it('completing a job completes its booking and approved work, resets the matching service interval and writes the service history', async () => {
    const types = await listServiceTypes(ws.ctx);
    const minor = types.find((t) => t.name === 'Minor service')!;
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Svc');
    await addInterval(ws.ctx, vehicle.id, { name: 'Minor service interval', serviceTypeId: minor.id, everyKm: 15_000, everyMonths: 12, lastServiceKm: 30_000, lastServiceAt: '2024-01-01' });
    const booking = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: minor.id, date: nextWeekday(30), time: '09:00' });
    const { job } = await checkInBooking(ws.ctx, booking.id, { mileageKm: 50_400 });
    await changeJobStatus(ws.ctx, job.id, { status: 'INSPECTION' });
    await changeJobStatus(ws.ctx, job.id, { status: 'DIAGNOSIS' });
    const w1 = await createRecommendedWork(ws.ctx, job.id, { description: 'Oil and filter change' });
    await changeJobStatus(ws.ctx, job.id, { status: 'AWAITING_APPROVAL' });
    await decideRecommendedWork(ws.ctx, job.id, w1.id, { decision: 'APPROVED', method: 'IN_PERSON' });
    for (const s of ['APPROVED', 'IN_PROGRESS', 'QUALITY_CHECK'] as const) await changeJobStatus(ws.ctx, job.id, { status: s });
    await recordQualityCheck(ws.ctx, job.id, { passed: true, checklist: { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: 'na', requested_work_completed: true } });
    await changeJobStatus(ws.ctx, job.id, { status: 'COMPLETED', mileageOutKm: 50_410, completionSummary: 'Minor service done' });

    expect((await ownerQuery('SELECT status FROM bookings WHERE id = $1', [booking.id])).rows[0]!.status).toBe('COMPLETED');
    expect((await ownerQuery('SELECT completed_at FROM recommended_work_items WHERE id = $1', [w1.id])).rows[0]!.completed_at).toBeInstanceOf(Date);
    const [interval] = await listIntervals(ws.ctx, vehicle.id);
    expect(interval!).toMatchObject({ lastServiceKm: 50_410 });
    expect(interval!.status).toMatchObject({ overdue: false, nextDueKm: 65_410 });

    const hist = await listServiceHistory(ws.ctx, vehicle.id, {});
    expect(hist.items).toHaveLength(1);
    expect(hist.items[0]).toMatchObject({ jobNumber: job.jobNumber, mileageKm: 50_410, serviceType: 'Minor service', summary: 'Minor service done', workPerformed: ['Oil and filter change'] });
    expect((await getVehicle(ws.ctx, vehicle.id)).status).toBe('ACTIVE');
  });

  it('an open or cancelled job is not service history', async () => {
    const { vehicle } = await jobAt('IN_PROGRESS');
    expect((await listServiceHistory(ws.ctx, vehicle.id, {})).items).toEqual([]);
  });
});

describe('assignment', () => {
  it('only people who can assign may assign or reassign, and only to active members of this business', async () => {
    const { job } = await jobAt('CHECKED_IN');
    await expect(assignTechnicians(tech.ctx, job.id, { primaryTechnicianMembershipId: tech.ctx.membership.id })).rejects.toMatchObject({ status: 403 });
    const r = await assignTechnicians(advisor.ctx, job.id, { primaryTechnicianMembershipId: tech.ctx.membership.id, additionalTechnicianMembershipIds: [otherTech.ctx.membership.id] });
    expect(r.primaryTechnicianMembershipId).toBe(tech.ctx.membership.id);
    const card = await getJobCard(ws.ctx, job.id);
    expect(card.additionalTechnicians.map((t) => t.membershipId)).toEqual([otherTech.ctx.membership.id]);
    // both technicians now see it in My Jobs
    expect((await listMyJobs(tech.ctx)).map((j) => j.id)).toContain(job.id);
    expect((await listMyJobs(otherTech.ctx)).map((j) => j.id)).toContain(job.id);
    expect((await listMyJobs(advisor.ctx)).map((j) => j.id)).not.toContain(job.id);

    const outsider = await createWorkspace('Outsider Workshop');
    const foreign = (await createMemberCtx(outsider, 'technician')).ctx.membership.id;
    await expect(assignTechnicians(ws.ctx, job.id, { primaryTechnicianMembershipId: foreign })).rejects.toMatchObject({ status: 422 });
    await expect(assignTechnicians(ws.ctx, job.id, { primaryTechnicianMembershipId: ws.ctx.membership.id })).resolves.toBeTruthy();
    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE resource_id = $1 AND action = 'job.technician_assigned' ORDER BY created_at", [job.id]);
    expect(a.rows.length).toBeGreaterThanOrEqual(2);
    expect(a.rows[0]!.after).toMatchObject({ primary: tech.ctx.membership.id });
  });

  it('a suspended member can no longer be assigned', async () => {
    const { job } = await jobAt('CHECKED_IN');
    const gone = await createMemberCtx(ws, 'technician');
    await ownerQuery("UPDATE memberships SET status = 'SUSPENDED' WHERE id = $1", [gone.ctx.membership.id]);
    await expect(assignTechnicians(ws.ctx, job.id, { primaryTechnicianMembershipId: gone.ctx.membership.id })).rejects.toMatchObject({ status: 422 });
  });

  it('priority changes are audited', async () => {
    const { job } = await jobAt('CHECKED_IN');
    await updateJob(advisor.ctx, job.id, { priority: 'URGENT' });
    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE resource_id = $1 AND action = 'job.priority_changed'", [job.id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ before: { priority: 'NORMAL' }, after: { priority: 'URGENT' } });
  });
});

describe('notes', () => {
  it('notes are internal unless made visible, and changing visibility is audited with who and when', async () => {
    const { job } = await jobAt('CHECKED_IN');
    const internal = await addJobNote(ws.ctx, job.id, { body: 'Customer is difficult about price' });
    expect(internal.visibility).toBe('INTERNAL');
    const shared = await addJobNote(ws.ctx, job.id, { body: 'Your car is on the lift', visibility: 'CUSTOMER' });
    expect(shared.visibility).toBe('CUSTOMER');
    await setJobNoteVisibility(ws.ctx, job.id, shared.id, 'INTERNAL');
    const a = await ownerQuery("SELECT user_id, before, after, created_at FROM audit_logs WHERE resource_id = $1 AND action = 'job.note_visibility_changed'", [job.id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ user_id: ws.ctx.user.id, before: { visibility: 'CUSTOMER' }, after: { visibility: 'INTERNAL' } });
  });
});

describe('searching and filtering jobs', () => {
  it('finds jobs by number, customer, registration, VIN, technician and status, and paginates consistently', async () => {
    const w = await createWorkspace('Job Search Workshop');
    const t = await createMemberCtx(w, 'technician');
    const tUser = await ownerQuery('SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1', [t.ctx.membership.id]);
    const made: { id: string; jobNumber: string; customer: { name: string }; vehicle: { registration: string | null; vin: string | null } }[] = [];
    for (let i = 0; i < 6; i++) {
      const { customer, vehicle } = await seedCustomerVehicle(w, `Srch${i}`);
      await ownerQuery('UPDATE vehicles SET vin = $2 WHERE id = $1', [vehicle.id, `VIN${i}ABCDEFGH1234`.slice(0, 17).toUpperCase()]);
      const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, priority: i % 2 ? 'HIGH' : 'NORMAL', primaryTechnicianMembershipId: i < 2 ? t.ctx.membership.id : undefined });
      made.push({ ...job, customer, vehicle: { registration: vehicle.registration, vin: `VIN${i}ABCDEFGH1234`.slice(0, 17).toUpperCase() } });
    }
    const ids = async (q: Record<string, unknown>) => (await listJobs(w.ctx, q)).items.map((j) => j.id);
    expect(await ids({ q: made[3]!.jobNumber })).toEqual([made[3]!.id]);
    expect(await ids({ q: made[2]!.customer.name })).toEqual([made[2]!.id]);
    expect(await ids({ q: made[4]!.vehicle.registration! })).toEqual([made[4]!.id]);
    expect(await ids({ q: made[5]!.vehicle.vin! })).toEqual([made[5]!.id]);
    expect((await ids({ q: tUser.rows[0]!.name })).sort()).toEqual([made[0]!.id, made[1]!.id].sort());
    expect(await ids({ technicianId: t.ctx.membership.id })).toHaveLength(2);
    expect(await ids({ priority: 'HIGH' })).toHaveLength(3);
    expect(await ids({ status: 'CHECKED_IN' })).toHaveLength(6);
    expect(await ids({ status: 'COMPLETED' })).toHaveLength(0);
    expect(await ids({ status: 'open' })).toHaveLength(6);
    expect(await ids({ from: '2020-01-01', to: '2020-01-02' })).toHaveLength(0);
    expect(await ids({ customerId: made[1]!.customer ? (await ownerQuery('SELECT customer_id FROM job_cards WHERE id = $1', [made[1]!.id])).rows[0]!.customer_id : '' })).toEqual([made[1]!.id]);

    const seen = new Set<string>();
    for (const page of [1, 2, 3]) for (const j of (await listJobs(w.ctx, { page, pageSize: 2 })).items) seen.add(j.id);
    expect(seen.size).toBe(6);
    expect((await listJobs(w.ctx, { page: 2, pageSize: 2 })).meta).toMatchObject({ total: 6, totalPages: 3, page: 2 });
    expect((await listJobs(w.ctx, { sort: 'priority', dir: 'asc' })).items[0]!.priority).toBe('HIGH');
    await expect(listJobs(w.ctx, { sort: 'password' })).rejects.toMatchObject({ status: 422 });
    await expect(listJobs(w.ctx, { status: 'FLYING' })).rejects.toMatchObject({ status: 422 });
  });

  it('a user in another business is never shown these jobs', async () => {
    const other = await createWorkspace('Nosy Workshop');
    expect((await listJobs(other.ctx, {})).items).toEqual([]);
    expect((await listJobs(other.ctx, { q: 'JOB' })).items).toEqual([]);
    const some = await ownerQuery('SELECT id FROM job_cards LIMIT 1');
    await expect(getJobCard(other.ctx, some.rows[0]!.id)).rejects.toMatchObject({ status: 404 });
  });

  it('the job number is unique within a business even when many are opened at once', async () => {
    const w = await createWorkspace('Numbering Workshop');
    const pairs = await Promise.all(Array.from({ length: 8 }, () => seedCustomerVehicle(w, 'Num')));
    const jobs = await Promise.all(pairs.map((p) => createJob(w.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id })));
    const numbers = jobs.map((j) => j.job.jobNumber).sort();
    expect(new Set(numbers).size).toBe(8);
    expect(numbers[0]).toBe('JOB-0000001');
    expect(numbers[7]).toBe('JOB-0000008');
  });
});

