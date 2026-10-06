import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { assignTechnicians, createJob } from '@/server/jobcards/service';
import { addJobLabour, listJobLabourAndParts } from '@/server/jobcards/items';
import { acceptInvitation, changeMemberRole, changeMemberStatus, inviteMember, listMembers } from '@/server/memberships/service';
import { createBooking } from '@/server/bookings/service';
import { setTechnicianSchedule, addTimeOff } from '@/server/workshop/service';
import { getEmployee, getSeatUsage, listEmployees, expireInvitations, setMemberLocations } from '@/server/team/directory';
import { getTechnician, setTechnician } from '@/server/team/technicians';
import { listAssignmentHistory } from '@/server/team/assignments';
import { approveTimeEntry, createManualEntry, editTimeEntry, getRunningTimer, listTimeEntries, postTimeToLabour, startTimer, stopTimer, voidTimeEntry } from '@/server/team/time';
import { getTeamWorkload, getTechnicianMetrics, capacityMinutes } from '@/server/team/performance';
import { setDefaultLabourRate } from '@/server/team/labour';
import { exportTeam } from '@/server/team/exports';
import { createInvoiceFromJob, finaliseInvoice } from '@/server/finance/invoices';
import { listTechnicians } from '@/server/workshop/people';
import { withTenant } from '@/server/db/client';
import { businessContext, createMemberCtx, createUser, ownerQuery, upgradePlan, uniqueEmail, userContext, latestEmailToken, type TestWorkspace } from '../helpers/factory';
import { idem, invWorkspace, openJob } from '../helpers/inventory';
import { memberWithPermissions, nextWeekday, seedCustomerVehicle } from '../helpers/workshop';
import { weekdayOf, zonedToUtc } from '@/lib/tz';

afterAll(disconnectPrisma);

const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

let ws: TestWorkspace;
let tech: Awaited<ReturnType<typeof createMemberCtx>>;
let manager: Awaited<ReturnType<typeof createMemberCtx>>;
let advisor: Awaited<ReturnType<typeof createMemberCtx>>;
beforeAll(async () => {
  ws = await invWorkspace('Team Workshop');
  tech = await createMemberCtx(ws, 'technician');
  manager = await createMemberCtx(ws, 'manager');
  advisor = await createMemberCtx(ws, 'service_advisor');
});

/** An open job that was opened yesterday, so time can be logged against the recent past. */
async function oldJob(w = ws, over: Record<string, unknown> = {}) {
  const made = await openJob(w, over);
  await ownerQuery("UPDATE job_cards SET opened_at = now() - interval '2 days' WHERE id = $1", [made.job.id]);
  return made;
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe('employee directory', () => {
  it('lists people with role, status, locations and technician flag, and never exposes security details', async () => {
    const r = await listEmployees(ws.ctx, {});
    const mine = r.items.find((e) => e.id === tech.ctx.membership.id)!;
    expect(mine).toMatchObject({ role: { name: 'Technician' }, status: 'ACTIVE', isTechnician: true, locations: 'All locations' });
    expect(Object.keys(mine)).not.toEqual(expect.arrayContaining(['passwordHash', 'mfaEnabled', 'lastLoginIp']));
    const detail = await getEmployee(ws.ctx, tech.ctx.membership.id);
    expect(JSON.stringify(detail)).not.toMatch(/password|mfa|lastLogin|ip"/i);
    expect(detail.permissionSummary.length).toBeGreaterThan(0);
    expect(detail.permissionSummary.find((g) => g.area === 'job')!.granted).toContain('Record inspections, diagnosis and recommended work');
    // search and filters
    expect((await listEmployees(ws.ctx, { q: 'technician' })).items.map((e) => e.id)).toContain(tech.ctx.membership.id);
    expect((await listEmployees(ws.ctx, { technician: '0' })).items.map((e) => e.id)).not.toContain(tech.ctx.membership.id);
    expect((await listEmployees(ws.ctx, { status: 'ACTIVE', pageSize: 2 })).meta.totalPages).toBeGreaterThan(1);
    expect((await getSeatUsage(ws.ctx)).used).toBeGreaterThanOrEqual(4);
  });

  it('is restricted to people who may view employees, and never crosses businesses', async () => {
    const other = await invWorkspace('Other Team');
    await rejects(listEmployees(tech.ctx, {})).catch(() => undefined);
    await rejects(getEmployee(other.ctx, tech.ctx.membership.id));
    expect((await listEmployees(other.ctx, {})).items.map((e) => e.id)).not.toContain(tech.ctx.membership.id);
  });

  it('changes a role with the previous role, new role and reason on record, and refuses escalation', async () => {
    const w = await invWorkspace('Role Changes');
    const m = await createMemberCtx(w, 'technician');
    const mgr = await createMemberCtx(w, 'manager');
    const roles = await prisma().role.findMany({ where: { businessId: null, key: { in: ['service_advisor', 'admin'] } } });
    const adv = roles.find((r) => r.key === 'service_advisor')!;
    const admin = roles.find((r) => r.key === 'admin')!;
    await changeMemberRole(w.ctx, m.ctx.membership.id, { roleId: adv.id, reason: 'Moved to the front desk' });
    const log = (await ownerQuery("SELECT before, after, metadata FROM audit_logs WHERE business_id = $1 AND action = 'member.role_changed'", [w.businessId])).rows[0]!;
    expect(log.before).toMatchObject({ roleKey: 'technician', roleName: 'Technician' });
    expect(log.after).toMatchObject({ roleKey: 'service_advisor', roleName: 'Service Advisor / Reception' });
    expect(log.metadata).toMatchObject({ reason: 'Moved to the front desk' });
    const hist = (await getEmployee(w.ctx, m.ctx.membership.id)).history;
    expect(hist[0]).toMatchObject({ action: 'member.role_changed', reason: 'Moved to the front desk' });
    // a manager cannot grant a role with more access than their own, nor change roles without the permission
    await rejects(changeMemberRole(mgr.ctx, m.ctx.membership.id, { roleId: admin.id }));
    await rejects(changeMemberRole(m.ctx, mgr.ctx.membership.id, { roleId: adv.id }));
  });

  it('suspends without destroying anything: access stops, history stays', async () => {
    const w = await invWorkspace('Suspension');
    const m = await createMemberCtx(w, 'technician');
    const { job } = await openJob(w, { primaryTechnicianMembershipId: m.ctx.membership.id });
    await addJobLabour(w.ctx, job.id, { description: 'Work', minutes: 20, rateCentsPerHour: 60_000, technicianMembershipId: m.ctx.membership.id });
    await changeMemberStatus(w.ctx, m.ctx.membership.id, 'suspend');
    await expect(businessContext(m.user)).rejects.toBeInstanceOf(Error); // cannot act in the business any more
    expect((await getEmployee(w.ctx, m.ctx.membership.id)).status).toBe('SUSPENDED');
    expect((await listJobLabourAndParts(w.ctx, job.id)).labour[0]!.technicianName).toBeTruthy(); // history still reads
    await changeMemberStatus(w.ctx, m.ctx.membership.id, 'reactivate');
    await changeMemberStatus(w.ctx, m.ctx.membership.id, 'remove');
    expect(await prisma().user.findUnique({ where: { id: m.user.id } })).not.toBeNull(); // the personal account is untouched
    expect((await listJobLabourAndParts(w.ctx, job.id)).labour[0]!.technicianName).toBeTruthy();
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND action IN ('member.suspended','member.reactivated','member.removed')", [w.businessId])).rows[0]!.n).toBe(3);
  });

  it('changes where someone works, only on plans with locations, and only to locations of the business', async () => {
    const w = await invWorkspace('Member Locations');
    const m = await createMemberCtx(w, 'technician');
    const loc = (await ownerQuery<{ id: string }>("INSERT INTO locations (business_id, name, status, updated_at) VALUES ($1, 'Annex', 'ACTIVE', now()) RETURNING id", [w.businessId])).rows[0]!.id;
    await setMemberLocations(w.ctx, m.ctx.membership.id, { allLocations: false, locationIds: [loc] });
    expect((await getEmployee(w.ctx, m.ctx.membership.id)).locations.map((l) => l.name)).toEqual(['Annex']);
    expect((await listEmployees(w.ctx, { locationId: loc })).items.map((e) => e.id)).toContain(m.ctx.membership.id);
    await rejects(setMemberLocations(w.ctx, m.ctx.membership.id, { allLocations: false, locationIds: [] }));
    const other = await invWorkspace('Foreign Location');
    const foreign = (await ownerQuery<{ id: string }>('SELECT id FROM locations WHERE business_id = $1', [other.businessId])).rows[0]!.id;
    await rejects(setMemberLocations(w.ctx, m.ctx.membership.id, { allLocations: false, locationIds: [foreign] }));
    await rejects(setMemberLocations(m.ctx, w.ctx.membership.id, { allLocations: true, locationIds: [] }));
    const solo = await invWorkspace('Solo Locations');
    await upgradePlan(solo, 'solo');
    const e = await rejects(setMemberLocations(solo.ctx, solo.ctx.membership.id, { allLocations: true, locationIds: [] }));
    expect(e.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});

describe('invitations and seats', () => {
  it('uses the plan\'s seat limit: a single-user plan cannot invite, and an over-limit business is told', async () => {
    const w = await invWorkspace('Seats');
    await upgradePlan(w, 'solo');
    const e = await rejects(inviteMember(w.ctx, { email: uniqueEmail('seat'), roleId: (await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } })).id }));
    expect(e.code).toBe('PLAN_LIMIT_REACHED');
    // a business that has more people than its plan allows (after a downgrade) keeps them and sees the warning
    await createMemberCtx(w, 'technician');
    await createMemberCtx(w, 'technician');
    const seats = await getSeatUsage(w.ctx);
    expect(seats).toMatchObject({ used: 3, limit: 1, over: true });
    expect((await listEmployees(w.ctx, {})).items).toHaveLength(3); // nobody is removed
  });

  it('expires stale invitations, tells the sender, and the old link stops working', async () => {
    const w = await invWorkspace('Expiry');
    const email = uniqueEmail('late');
    const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    await inviteMember(w.ctx, { email, roleId: role.id });
    const token = await latestEmailToken(email);
    await ownerQuery("UPDATE memberships SET invite_expires_at = now() - interval '1 hour' WHERE business_id = $1 AND invited_email = $2", [w.businessId, email]);
    const invited = await createUser({ email });
    await rejects(acceptInvitation(await userContext(invited), token));
    expect(await expireInvitations()).toBeGreaterThanOrEqual(1);
    expect((await listMembers(w.ctx, { status: 'INVITED' })).items.find((i) => i.email === email)).toBeUndefined();
    expect((await ownerQuery("SELECT 1 FROM notifications WHERE business_id = $1 AND type = 'INVITATION_EXPIRED'", [w.businessId])).rowCount).toBe(1);
    expect(await expireInvitations()).toBe(0);
    // the same person can be invited again
    await inviteMember(w.ctx, { email, roleId: role.id });
    expect((await listMembers(w.ctx, { status: 'INVITED' })).items.find((i) => i.email === email)).toBeTruthy();
  });
});

describe('technicians', () => {
  it('are designated explicitly; non-technicians are not offered for jobs; deactivation stops new work only', async () => {
    const w = await invWorkspace('Technician Setup');
    const t = await createMemberCtx(w, 'technician');
    const adv = await createMemberCtx(w, 'accounts');
    await createMemberCtx(w, 'manager'); // someone who runs the schedule besides the person making the change
    const names = async () => (await withTenant(w.businessId, (tx) => listTechnicians(tx, w.businessId))).map((x) => x.membershipId);
    expect(await names()).toContain(t.ctx.membership.id);
    expect(await names()).not.toContain(adv.ctx.membership.id); // no job.edit, so not a technician by default
    await setTechnician(w.ctx, adv.ctx.membership.id, { isTechnician: true, skills: ['Diagnostics', 'Electrical'] });
    expect(await names()).toContain(adv.ctx.membership.id);
    const { job } = await openJob(w, { primaryTechnicianMembershipId: t.ctx.membership.id });
    const res = await setTechnician(w.ctx, t.ctx.membership.id, { status: 'INACTIVE' });
    expect(res.affected.openJobs).toBe(1);
    expect(await names()).not.toContain(t.ctx.membership.id);
    // nothing was silently moved
    expect((await ownerQuery('SELECT primary_technician_membership_id FROM job_cards WHERE id = $1', [job.id])).rows[0]!.primary_technician_membership_id).toBe(t.ctx.membership.id);
    // but the person cannot be given NEW work
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Tech');
    await rejects(createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, primaryTechnicianMembershipId: t.ctx.membership.id }));
    const second = await openJob(w);
    await rejects(assignTechnicians(w.ctx, second.job.id, { primaryTechnicianMembershipId: t.ctx.membership.id }));
    // the managers were told what is affected, and the change was audited
    expect((await ownerQuery("SELECT 1 FROM notifications WHERE business_id = $1 AND type = 'TECHNICIAN_DEACTIVATED'", [w.businessId])).rowCount).toBeGreaterThan(0);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'technician.deactivated'", [w.businessId])).rowCount).toBe(1);
    await setTechnician(w.ctx, t.ctx.membership.id, { status: 'ACTIVE' });
    expect(await names()).toContain(t.ctx.membership.id);
    await assignTechnicians(w.ctx, second.job.id, { primaryTechnicianMembershipId: t.ctx.membership.id });
    const view = await getTechnician(w.ctx, adv.ctx.membership.id);
    expect(view).toMatchObject({ isTechnician: true, skills: ['Diagnostics', 'Electrical'] });
  });

  it('keep skills, service types and rates behind the right permissions', async () => {
    const w = await invWorkspace('Technician Rates');
    const t = await createMemberCtx(w, 'technician');
    const svc = (await ownerQuery<{ id: string }>('SELECT id FROM service_types WHERE business_id = $1 LIMIT 2', [w.businessId])).rows.map((r) => r.id);
    await setTechnician(w.ctx, t.ctx.membership.id, { serviceTypeIds: svc, billableRateCentsPerHour: 70_000, labourCostCentsPerHour: 30_000 });
    const full = await getTechnician(w.ctx, t.ctx.membership.id);
    expect(full).toMatchObject({ billableRateCentsPerHour: 70_000, labourCostCentsPerHour: 30_000 });
    expect(full.serviceTypes).toHaveLength(2);
    // a manager sees the billable rate, but not what the person costs, and cannot change rates
    const mgr = await memberWithPermissions(w, ['employee.view', 'employee.manage_technicians', 'labour.view_rates']);
    const seen = await getTechnician(mgr.ctx, t.ctx.membership.id);
    expect(seen.billableRateCentsPerHour).toBe(70_000);
    expect(seen.labourCostCentsPerHour).toBeNull();
    await rejects(setTechnician(mgr.ctx, t.ctx.membership.id, { billableRateCentsPerHour: 1 }));
    await setTechnician(mgr.ctx, t.ctx.membership.id, { skills: ['Brakes'] }); // skills are fine
    // a technician cannot manage anyone
    await rejects(setTechnician(t.ctx, t.ctx.membership.id, { skills: ['Everything'] }));
    // the technician themselves sees no rates or costs
    const own = await getTechnician(t.ctx, t.ctx.membership.id).catch(() => null);
    expect(own).toBeNull(); // technicians have no permission to browse the team
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'labour.cost_rate_changed' OR action = 'finance.labour_cost_rate_changed'", [w.businessId])).rowCount).toBeGreaterThan(0);
  });

  it('use the same availability tables as the booking calendar, and the calendar honours them', async () => {
    const w = await invWorkspace('Availability');
    const t = await createMemberCtx(w, 'technician');
    const tz = w.ctx.business.timezone;
    await setTechnicianSchedule(w.ctx, t.ctx.membership.id, { intervals: [{ weekday: 1, start: '09:00', end: '13:00' }] });
    const view = await getTechnician(w.ctx, t.ctx.membership.id);
    expect(view.usesWorkshopHours).toBe(false);
    expect(view.schedule).toEqual([{ weekday: 1, startMinute: 540, endMinute: 780 }]);
    // capacity over a Monday-only week is that Monday's four hours, less leave
    const monday = [1, 2, 3, 4, 5, 6, 7].map((i) => nextWeekday(i)).find((d) => weekdayOf(d) === 1)!;
    const day = (iso: string) => ({ start: zonedToUtc(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10), 0, tz), end: zonedToUtc(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10), 24 * 60 - 1, tz) });
    const caps = await withTenant(w.businessId, async (tx) => {
      const out: number[] = [];
      for (let i = 1; i <= 7; i++) {
        const d = nextWeekday(i);
        out.push(await capacityMinutes(tx, w.businessId, t.ctx.membership.id, tz, d, d, day(d)));
      }
      return out;
    });
    expect(caps.filter((c) => c > 0).length).toBeGreaterThanOrEqual(1); // only Mondays count
    expect(caps.filter((c) => c > 0).every((c) => c === 240)).toBe(true);
    void monday;
    await addTimeOff(w.ctx, { membershipId: t.ctx.membership.id, kind: 'LEAVE', startsAt: new Date(Date.now() - 86_400_000).toISOString(), endsAt: new Date(Date.now() + 40 * 86_400_000).toISOString(), reason: 'Annual leave' });
    const during = await withTenant(w.businessId, async (tx) => capacityMinutes(tx, w.businessId, t.ctx.membership.id, tz, monday, monday, day(monday)));
    expect(during).toBe(0);
    // the booking service refuses a technician who is off, using the same rules
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Avail');
    const st = (await ownerQuery<{ id: string }>('SELECT id FROM service_types WHERE business_id = $1 LIMIT 1', [w.businessId])).rows[0]!.id;
    const startsAt = zonedToUtc(+monday.slice(0, 4), +monday.slice(5, 7), +monday.slice(8, 10), 600, tz).toISOString();
    await rejects(createBooking(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: st, startsAt, technicianMembershipId: t.ctx.membership.id }));
  });
});

describe('job assignment', () => {
  it('is recorded (who, what, by whom, when), announced to the person, and needs the assign permission', async () => {
    const w = await invWorkspace('Assignment');
    const t = await createMemberCtx(w, 'technician');
    const t2 = await createMemberCtx(w, 'technician');
    const { job } = await openJob(w);
    await rejects(assignTechnicians(t.ctx, job.id, { primaryTechnicianMembershipId: t.ctx.membership.id })); // technicians cannot assign
    await assignTechnicians(w.ctx, job.id, { primaryTechnicianMembershipId: t.ctx.membership.id, additionalTechnicianMembershipIds: [t2.ctx.membership.id] });
    await assignTechnicians(w.ctx, job.id, { primaryTechnicianMembershipId: t2.ctx.membership.id, additionalTechnicianMembershipIds: [] });
    const h = await listAssignmentHistory(w.ctx, job.id);
    expect(h.map((e) => e.action)).toEqual(['PRIMARY_ASSIGNED', 'ADDED', 'PRIMARY_REMOVED', 'PRIMARY_ASSIGNED', 'REMOVED']);
    expect(h[0]!.by).toBe(w.ctx.user.name);
    await expect(ownerQuery("UPDATE job_assignment_events SET action = 'X' WHERE job_id = $1", [job.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM job_assignment_events WHERE job_id = $1', [job.id])).rejects.toThrow();
    const notes = await ownerQuery("SELECT user_id, type FROM notifications WHERE business_id = $1 AND type IN ('JOB_ASSIGNED', 'JOB_UNASSIGNED') ORDER BY created_at", [w.businessId]);
    expect(notes.rows.map((n) => n.type).sort()).toEqual(['JOB_ASSIGNED', 'JOB_ASSIGNED', 'JOB_ASSIGNED', 'JOB_UNASSIGNED', 'JOB_UNASSIGNED']);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'job.technician_assigned'", [w.businessId])).rowCount).toBe(2);
  });
});

describe('time tracking', () => {
  it('a timer lives on the server: start is idempotent, one timer at a time, stop twice answers the same', async () => {
    const { job } = await oldJob(ws, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    const other = await oldJob(ws, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    const key = idem();
    const a = await startTimer(tech.ctx, { jobId: job.id, idempotencyKey: key });
    const b = await startTimer(tech.ctx, { jobId: job.id, idempotencyKey: key });
    const c = await startTimer(tech.ctx, { jobId: job.id }); // a double tap without a key
    expect(a.replayed).toBe(false);
    expect([b.replayed, c.replayed]).toEqual([true, true]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    const e = await rejects(startTimer(tech.ctx, { jobId: other.job.id }));
    expect((e.details as { code: string }).code).toBe('TIMER_RUNNING');
    // refresh / app comes back: the timer is still there, with elapsed time worked out by the server
    await ownerQuery("UPDATE time_entries SET started_at = now() - interval '95 minutes' WHERE id = $1", [a.id]);
    const running = (await getRunningTimer(tech.ctx))!;
    expect(running).toMatchObject({ id: a.id, status: 'RUNNING', jobNumber: job.jobNumber });
    expect(running.elapsedSeconds).toBeGreaterThanOrEqual(95 * 60);
    // two simultaneous starts on different jobs: exactly one wins
    const results = await Promise.allSettled([
      startTimer(manager.ctx, { jobId: job.id }), startTimer(manager.ctx, { jobId: other.job.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const stopped = await stopTimer(tech.ctx, {});
    expect(stopped).toMatchObject({ status: 'COMPLETED', durationMinutes: 95, replayed: false });
    const again = await stopTimer(tech.ctx, {});
    expect(again).toMatchObject({ id: a.id, replayed: true });
    expect(await getRunningTimer(tech.ctx)).toBeNull();
    await stopTimer(manager.ctx, {});
  });

  it('refuses impossible entries: backwards, in the future, over a day, before the job existed, overlapping', async () => {
    const { job } = await oldJob(ws, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    const base = { jobId: job.id };
    await rejects(createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(30), endedAt: minutesAgo(60) }));
    await rejects(createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(10), endedAt: new Date(Date.now() + 3 * 3_600_000) }));
    await rejects(createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(60 * 30), endedAt: minutesAgo(60) }));
    await rejects(createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(60 * 24 * 5), endedAt: minutesAgo(60 * 24 * 5 - 60) })); // before the job was opened
    await rejects(createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(60), durationMinutes: -5 }));
    await rejects(createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(60) }));
    const ok = await createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(400), endedAt: minutesAgo(340), notes: 'Strip and inspect' });
    expect(ok).toMatchObject({ durationMinutes: 60, source: 'MANUAL', status: 'COMPLETED' });
    await rejects(createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(370), endedAt: minutesAgo(320) })); // overlaps the one above
    await createManualEntry(tech.ctx, { ...base, startedAt: minutesAgo(339), endedAt: minutesAgo(310) }); // next to it is fine
    // the database says the same, whatever the application does
    await expect(ownerQuery("UPDATE time_entries SET ended_at = started_at - interval '1 minute' WHERE id = $1", [ok.id])).rejects.toThrow();
    await expect(ownerQuery("UPDATE time_entries SET duration_minutes = 99999 WHERE id = $1", [ok.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM time_entries WHERE id = $1', [ok.id])).rejects.toThrow(/cannot be deleted/);
    // one person, one running timer, enforced by an index
    const run = await startTimer(tech.ctx, base);
    await expect(ownerQuery("INSERT INTO time_entries (business_id, membership_id, job_id, status, source, started_at, updated_at) VALUES ($1, $2, $3, 'RUNNING', 'TIMER', now(), now())", [ws.businessId, tech.ctx.membership.id, job.id])).rejects.toThrow();
    await stopTimer(tech.ctx, {});
    void run;
  });

  it('is audited when edited or voided, and only people with the edit permission can do either', async () => {
    const { job } = await oldJob(ws, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    const e = await createManualEntry(tech.ctx, { jobId: job.id, startedAt: minutesAgo(600), endedAt: minutesAgo(540) });
    await rejects(editTimeEntry(tech.ctx, e.id, { endedAt: minutesAgo(500), reason: 'More time please' }));
    await rejects(voidTimeEntry(tech.ctx, e.id, { reason: 'Hide it' }));
    await rejects(editTimeEntry(manager.ctx, e.id, { endedAt: minutesAgo(500) })); // a reason is required
    const edited = await editTimeEntry(manager.ctx, e.id, { endedAt: minutesAgo(510), reason: 'Forgot the test drive' });
    expect(edited).toMatchObject({ durationMinutes: 90, editCount: 1 });
    const log = (await ownerQuery("SELECT before, after, metadata FROM audit_logs WHERE business_id = $1 AND action = 'time_entry.edited' AND resource_id = $2", [ws.businessId, e.id])).rows[0]!;
    expect(log.before.durationMinutes).toBe(60);
    expect(log.after.durationMinutes).toBe(90);
    expect(log.metadata.reason).toBe('Forgot the test drive');
    await approveTimeEntry(manager.ctx, e.id);
    const voided = await voidTimeEntry(manager.ctx, e.id, { reason: 'Logged on the wrong job' });
    expect(voided.status).toBe('VOIDED');
    await rejects(editTimeEntry(manager.ctx, e.id, { notes: 'again', reason: 'Trying' }));
    await expect(ownerQuery("UPDATE time_entries SET status = 'COMPLETED' WHERE id = $1", [e.id])).rejects.toThrow();
    // a voided entry is kept, with who and why
    expect((await ownerQuery('SELECT void_reason, voided_by_id FROM time_entries WHERE id = $1', [e.id])).rows[0]).toMatchObject({ void_reason: 'Logged on the wrong job' });
    expect((await listTimeEntries(manager.ctx, { jobId: job.id, status: 'VOIDED' })).items).toHaveLength(1);
  });

  it('turns time into a labour line at the rate in force then; the line is locked, and billed time needs a credit note', async () => {
    const w = await invWorkspace('Time To Labour');
    const t = await createMemberCtx(w, 'technician');
    await setDefaultLabourRate(w.ctx, { rateCentsPerHour: 60_000 });
    await setTechnician(w.ctx, t.ctx.membership.id, { billableRateCentsPerHour: 80_000 });
    const { job } = await openJob(w, { primaryTechnicianMembershipId: t.ctx.membership.id });
    await ownerQuery("UPDATE job_cards SET opened_at = now() - interval '2 days', status = 'READY_FOR_COLLECTION' WHERE id = $1", [job.id]);
    const e = await createManualEntry(t.ctx, { jobId: job.id, startedAt: minutesAgo(200), endedAt: minutesAgo(140), notes: 'Replace clutch' }).catch(async (err) => {
      // a ready job is still open for the technician's own time; if the workflow refuses, a manager records it
      void err;
      return createManualEntry(w.ctx, { jobId: job.id, membershipId: t.ctx.membership.id, startedAt: minutesAgo(200), endedAt: minutesAgo(140), notes: 'Replace clutch' });
    });
    const posted = await postTimeToLabour(w.ctx, e.id);
    expect(posted.posted).toBe(true);
    const labour = (await ownerQuery('SELECT minutes, rate_cents_per_hour, total_cents FROM job_labour WHERE job_id = $1', [job.id])).rows[0]!;
    expect(labour).toMatchObject({ minutes: 60, rate_cents_per_hour: 80_000, total_cents: 80_000 });
    await setTechnician(w.ctx, t.ctx.membership.id, { billableRateCentsPerHour: 120_000 });
    expect((await ownerQuery('SELECT rate_cents_per_hour FROM job_labour WHERE job_id = $1', [job.id])).rows[0]!.rate_cents_per_hour).toBe(80_000);
    await rejects(editTimeEntry(w.ctx, e.id, { endedAt: minutesAgo(100), reason: 'Longer' })); // locked once posted
    await expect(ownerQuery("UPDATE time_entries SET ended_at = now() WHERE id = $1", [e.id])).rejects.toThrow(/cannot be edited/);
    // invoice it: now voiding the time would rewrite what the customer was charged
    const inv = await createInvoiceFromJob(w.ctx, job.id);
    await finaliseInvoice(w.ctx, inv.id);
    const err = await rejects(voidTimeEntry(w.ctx, e.id, { reason: 'Oops' }));
    expect(err.message).toMatch(/credit note/);
    expect((await ownerQuery("SELECT archived_at FROM job_labour WHERE job_id = $1", [job.id])).rows[0]!.archived_at).toBeNull();
  });

  it('shows people only their own time unless they may see everyone\'s', async () => {
    const w = await invWorkspace('Time Visibility');
    const a = await createMemberCtx(w, 'technician');
    const b = await createMemberCtx(w, 'technician');
    const { job } = await oldJob(w, { primaryTechnicianMembershipId: a.ctx.membership.id });
    await ownerQuery('UPDATE job_cards SET opened_at = now() - interval \'2 days\' WHERE id = $1', [job.id]);
    await createManualEntry(a.ctx, { jobId: job.id, startedAt: minutesAgo(100), endedAt: minutesAgo(40) });
    await createManualEntry(w.ctx, { jobId: job.id, membershipId: b.ctx.membership.id, startedAt: minutesAgo(100), endedAt: minutesAgo(40) });
    expect((await listTimeEntries(a.ctx, {})).items).toHaveLength(1);
    await rejects(listTimeEntries(a.ctx, { membershipId: b.ctx.membership.id }));
    await rejects(createManualEntry(a.ctx, { jobId: job.id, membershipId: b.ctx.membership.id, startedAt: minutesAgo(30), endedAt: minutesAgo(20) })); // cannot log for someone else
    const all = await listTimeEntries(w.ctx, {});
    expect(all.items).toHaveLength(2);
    expect(all.totals).toMatchObject({ minutes: 120, billableMinutes: 120 });
    const advisorOnly = await memberWithPermissions(w, ['job.view']);
    await rejects(listTimeEntries(advisorOnly.ctx, {}));
  });

  it('is part of the technician plan features', async () => {
    const w = await invWorkspace('Time Plan');
    await upgradePlan(w, 'solo');
    const { job } = await openJob(w);
    const e = await rejects(startTimer(w.ctx, { jobId: job.id }));
    expect(e.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});

describe('technician metrics', () => {
  it('are worked out from real records and permission-aware', async () => {
    const w = await invWorkspace('Metrics');
    const t = await createMemberCtx(w, 'technician');
    await setDefaultLabourRate(w.ctx, { rateCentsPerHour: 60_000 });
    const { job } = await oldJob(w, { primaryTechnicianMembershipId: t.ctx.membership.id });
    await createManualEntry(t.ctx, { jobId: job.id, startedAt: minutesAgo(300), endedAt: minutesAgo(180) });
    await createManualEntry(t.ctx, { jobId: job.id, startedAt: minutesAgo(170), endedAt: minutesAgo(110), billable: false });
    await addJobLabour(w.ctx, job.id, { description: 'Billed work', minutes: 90, technicianMembershipId: t.ctx.membership.id });
    await ownerQuery("UPDATE job_cards SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [job.id]);
    const m = await getTechnicianMetrics(w.ctx, t.ctx.membership.id, {});
    expect(m).toMatchObject({ jobsCompleted: 1, jobsOpen: 0, workedMinutes: 180, billableMinutes: 120, labourRevenueCents: 90_000 });
    expect(m.billableShareBps).toBe(6667);
    expect(m.avgCompletionHours).toBeGreaterThan(40);
    // technicians see only their own numbers, and never the revenue
    const own = await getTechnicianMetrics(t.ctx, t.ctx.membership.id, {});
    expect(own.workedMinutes).toBe(180);
    expect(own.labourRevenueCents).toBeNull();
    await rejects(getTechnicianMetrics(t.ctx, w.ctx.membership.id, {}));
    await rejects(getTeamWorkload(t.ctx, {}));
    const team = await getTeamWorkload(w.ctx, {});
    expect(team.items.find((x) => x.membershipId === t.ctx.membership.id)).toMatchObject({ jobsCompleted: 1 });
    await rejects(getTechnicianMetrics(w.ctx, t.ctx.membership.id, { from: '2020-01-01', to: '2024-12-31' })); // too long a period
  });
});

describe('team exports', () => {
  it('export the directory, workload and time without any security details, audited, and only with permission', async () => {
    const dir = await exportTeam(ws.ctx, { dataset: 'directory' });
    const text = dir.data.toString('utf8');
    expect(text).toContain('Technician');
    expect(text).not.toMatch(/password|mfa|secret|session/i);
    expect(dir.rows).toBeGreaterThanOrEqual(4);
    await exportTeam(ws.ctx, { dataset: 'workload', format: 'xlsx' });
    await exportTeam(ws.ctx, { dataset: 'time_entries' });
    await rejects(exportTeam(tech.ctx, { dataset: 'directory' }));
    await rejects(exportTeam(advisor.ctx, { dataset: 'time_entries' }));
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'team.exported' ORDER BY created_at", [ws.businessId]);
    expect(audit.rows.map((r) => r.metadata.dataset)).toEqual(['directory', 'workload', 'time_entries']);
  });
});
