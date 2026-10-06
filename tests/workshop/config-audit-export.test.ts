import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { addWaitingEntry, cancelRecurringSeries, convertWaitingEntry, createRecurringSeries } from '@/server/bookings/extras';
import { cancelBooking, createBooking, rescheduleBooking, setBookingStatus } from '@/server/bookings/service';
import { assignTechnicians, changeJobStatus, checkInBooking, createJob, recordQualityCheck, updateCheckIn, updateJob, addJobNote, setJobNoteVisibility } from '@/server/jobcards/service';
import {
  completeInspection, confirmDiagnosis, createDiagnosis, createRecommendedWork, decideRecommendedWork, startInspection, updateDiagnosis, updateInspectionItem,
} from '@/server/jobcards/work';
import { addJobLabour, addJobPart, addJobPhoto, removeJobPhoto, setJobPhotoVisibility } from '@/server/jobcards/items';
import { createCustomer, setCustomerArchived, setCustomerStatus, updateCustomer } from '@/server/customers/service';
import { correctMileage, createVehicle, recordMileage, setVehicleArchived, setVehicleStatus, updateVehicle } from '@/server/vehicles/service';
import {
  addTimeOff, createBay, createServiceType, getRules, getWorkshopHours, getWorkshopLookups, listBays, listServiceTypes, setTechnicianSchedule, setWorkshopHours, updateBay, updateRules, updateServiceType,
} from '@/server/workshop/service';
import { EXPORT_DATASETS } from '@/server/exports/registry';
import { exportableDatasets } from '@/server/exports/service';
import { addDays, weekdayOf } from '@/lib/tz';
import { customerInput } from '../helpers/customers';
import { createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { memberWithPermissions, nextWeekday, seedCustomerVehicle } from '../helpers/workshop';
import { VALID_PNG } from '../helpers/images';

afterAll(disconnectPrisma);

const PNG = VALID_PNG;

describe('workshop configuration', () => {
  let ws: TestWorkspace;
  beforeAll(async () => {
    ws = await createWorkspace('Config Workshop');
  });

  it('a new business starts with sensible, editable defaults', async () => {
    const types = await listServiceTypes(ws.ctx);
    expect(types.map((t) => [t.name, t.defaultDurationMin])).toEqual([['Minor service', 120], ['Major service', 240], ['Diagnostic', 60], ['Brake service', 120], ['Tyres and alignment', 60]]);
    const hours = await getWorkshopHours(ws.ctx);
    expect(hours).toHaveLength(5);
    expect(hours[0]).toEqual({ weekday: 1, startMinute: 480, endMinute: 1020 });
    expect(await getRules(ws.ctx)).toMatchObject({ allowTechnicianOverlap: false, maxConcurrentJobs: null, requireCheckInSignature: false, notifyCustomerReschedule: true });
  });

  it('only people who manage the calendar can change it; everyone who works with bookings can read it', async () => {
    const advisorOnly = await memberWithPermissions(ws, ['booking.view', 'booking.create']);
    const clerk = await memberWithPermissions(ws, ['customer.view']);
    await expect(createServiceType(advisorOnly.ctx, { name: 'Sneaky', defaultDurationMin: 30 })).rejects.toMatchObject({ status: 403 });
    await expect(updateRules(advisorOnly.ctx, { allowTechnicianOverlap: true })).rejects.toMatchObject({ status: 403 });
    await expect(setWorkshopHours(advisorOnly.ctx, { intervals: [] })).rejects.toMatchObject({ status: 403 });
    await expect(createBay(advisorOnly.ctx, { name: 'Bay X' })).rejects.toMatchObject({ status: 403 });
    expect((await getWorkshopLookups(advisorOnly.ctx)).serviceTypes.length).toBeGreaterThan(0);
    await expect(getWorkshopLookups(clerk.ctx)).rejects.toMatchObject({ status: 403 });
  });

  it('service types: unique names, valid durations, archive instead of delete, and renaming never rewrites past bookings', async () => {
    const t = await createServiceType(ws.ctx, { name: 'Aircon regas', defaultDurationMin: 45 });
    await expect(createServiceType(ws.ctx, { name: 'aircon REGAS', defaultDurationMin: 45 })).rejects.toMatchObject({ status: 422 });
    await expect(createServiceType(ws.ctx, { name: 'Bad', defaultDurationMin: 1 })).rejects.toMatchObject({ status: 422 });
    await expect(createServiceType(ws.ctx, { name: 'Bad', defaultDurationMin: 5000 })).rejects.toMatchObject({ status: 422 });
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Cfg');
    const b = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: t.id, date: nextWeekday(40), time: '09:00' });
    expect(b).toMatchObject({ serviceLabel: 'Aircon regas', durationMin: 45 });
    await updateServiceType(ws.ctx, t.id, { name: 'A/C regas and leak test', defaultDurationMin: 90 });
    const row = await ownerQuery('SELECT service_label, duration_min FROM bookings WHERE id = $1', [b.id]);
    expect(row.rows[0]).toMatchObject({ service_label: 'Aircon regas', duration_min: 45 }); // history keeps what was booked
    await updateServiceType(ws.ctx, t.id, { archived: true });
    expect((await listServiceTypes(ws.ctx)).some((x) => x.id === t.id)).toBe(false);
    expect((await listServiceTypes(ws.ctx, { includeArchived: true })).some((x) => x.id === t.id)).toBe(true);
    await expect(createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: t.id, date: nextWeekday(41), time: '09:00' })).resolves.toBeTruthy(); // existing references still resolve for history; new use is guided by the active list
  });

  it('hours must be valid, non-overlapping, and replace the whole pattern', async () => {
    await expect(setWorkshopHours(ws.ctx, { intervals: [{ weekday: 1, start: '09:00', end: '08:00' }] })).rejects.toMatchObject({ status: 422 });
    await expect(setWorkshopHours(ws.ctx, { intervals: [{ weekday: 1, start: '08:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '14:00' }] })).rejects.toMatchObject({ status: 422 });
    await expect(setWorkshopHours(ws.ctx, { intervals: [{ weekday: 9, start: '08:00', end: '12:00' }] })).rejects.toMatchObject({ status: 422 });
    await expect(setWorkshopHours(ws.ctx, { intervals: [{ weekday: 1, start: '8am', end: '12:00' }] })).rejects.toMatchObject({ status: 422 });
    const set = await setWorkshopHours(ws.ctx, { intervals: [{ weekday: 1, start: '08:00', end: '12:00' }, { weekday: 1, start: '13:00', end: '17:00' }, { weekday: 6, start: '08:00', end: '13:00' }] });
    expect(set).toHaveLength(3);
    // a lunch break is a gap: starting in the gap is refused, a morning appointment is fine
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Gap');
    let monday = nextWeekday(1);
    while (weekdayOf(monday) !== 1) monday = addDays(monday, 1);
    const base = { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Gap test', durationMin: 30, date: monday };
    await expect(createBooking(ws.ctx, { ...base, time: '12:30' })).rejects.toMatchObject({ status: 409, details: { conflicts: [{ code: 'OUTSIDE_HOURS' }] } });
    expect((await createBooking(ws.ctx, { ...base, time: '09:00' })).status).toBe('CONFIRMED');
    expect((await createBooking(ws.ctx, { ...base, time: '13:00' })).status).toBe('CONFIRMED');
    await setWorkshopHours(ws.ctx, { intervals: [] });
    expect(await getWorkshopHours(ws.ctx)).toEqual([]);
    expect((await createBooking(ws.ctx, { ...base, time: '03:00' })).status).toBe('CONFIRMED'); // no hours configured = no restriction
  }, 20_000);

  it('bays: unique names, cannot be archived while upcoming bookings use them', async () => {
    const w = await createWorkspace('Bay Config Workshop');
    const bay = await createBay(w.ctx, { name: 'Lift 1' });
    await expect(createBay(w.ctx, { name: 'lift 1' })).rejects.toMatchObject({ status: 422 });
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Bay');
    await createBooking(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'x', durationMin: 60, date: nextWeekday(1), time: '09:00', bayId: bay.id });
    await expect(updateBay(w.ctx, bay.id, { archived: true })).rejects.toMatchObject({ status: 409 });
    expect((await listBays(w.ctx)).map((b) => b.id)).toEqual([bay.id]);
  });

  it('technician schedules and time off only accept active members of this business', async () => {
    const other = await createWorkspace('Foreign Schedules');
    const foreign = (await createMemberCtx(other, 'technician')).ctx.membership.id;
    await expect(setTechnicianSchedule(ws.ctx, foreign, { intervals: [] })).rejects.toMatchObject({ status: 422 });
    await expect(addTimeOff(ws.ctx, { membershipId: foreign, kind: 'LEAVE', startsAt: '2030-01-01T08:00:00Z', endsAt: '2030-01-02T08:00:00Z' })).rejects.toMatchObject({ status: 422 });
    const mine = (await createMemberCtx(ws, 'technician')).ctx.membership.id;
    await expect(addTimeOff(ws.ctx, { membershipId: mine, kind: 'LEAVE', startsAt: '2030-01-02T08:00:00Z', endsAt: '2030-01-01T08:00:00Z' })).rejects.toMatchObject({ status: 422 });
  });

  it('check-in confirmation can be made mandatory; the signature and typed name are recorded with the job', async () => {
    const w = await createWorkspace('Signature Workshop');
    await updateRules(w.ctx, { requireCheckInSignature: true });
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Sig');
    await expect(createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id })).rejects.toMatchObject({ status: 422, details: { signatureName: expect.any(String) } });
    expect((await ownerQuery('SELECT count(*)::int AS n FROM job_cards WHERE business_id = $1', [w.businessId])).rows[0]!.n).toBe(0); // nothing half-created
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, signatureName: 'J. Customer' });
    const ci = (await ownerQuery('SELECT signature_name, signed_at FROM job_check_ins WHERE job_id = $1', [job.id])).rows[0]!;
    expect(ci.signature_name).toBe('J. Customer');
    expect(ci.signed_at).toBeInstanceOf(Date);
    // the signature image is a private photo of this job, linked to the check-in
    const sig = await addJobPhoto(w.ctx, job.id, { data: PNG, filename: 'signature.png' }, { category: 'SIGNATURE' });
    const updated = await updateCheckIn(w.ctx, job.id, { signatureFileId: sig.fileId });
    expect(updated.signatureFileId).toBe(sig.fileId);
    await expect(updateCheckIn(w.ctx, job.id, { signatureFileId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ status: 422 });
  });

  it('checks in without a signature when the business does not require one', async () => {
    const w = await createWorkspace('No Signature Workshop');
    const { customer, vehicle } = await seedCustomerVehicle(w, 'NoSig');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id });
    expect(job.status).toBe('CHECKED_IN');
  });
});

describe('every important Part 3 action is audited, in the right business, by the right person', () => {
  it('records the full set of events for one realistic day', async () => {
    const ws = await createWorkspace('Audit Everything Workshop');
    const tech = await createMemberCtx(ws, 'technician');
    const manager = await createMemberCtx(ws, 'manager');
    const advisor = await createMemberCtx(ws, 'service_advisor');

    // customers and vehicles
    const c = await createCustomer(advisor.ctx, customerInput('Audit Person', { email: 'audit.person@example.test' }));
    await updateCustomer(advisor.ctx, c.id, { notes: 'Prefers mornings' });
    await setCustomerStatus(advisor.ctx, c.id, 'INACTIVE');
    await setCustomerStatus(advisor.ctx, c.id, 'ACTIVE');
    const v = await createVehicle(advisor.ctx, { customerId: c.id, registration: 'AUD 1 GP', make: 'VW', model: 'Polo', mileageKm: 10_000 });
    await updateVehicle(advisor.ctx, v.id, { colour: 'Red' });
    await recordMileage(advisor.ctx, v.id, { mileageKm: 10_500 });
    await correctMileage(manager.ctx, v.id, { mileageKm: 10_400, reason: 'Misread' });
    await setVehicleStatus(advisor.ctx, v.id, { status: 'AWAITING_SERVICE' });

    // configuration
    const type = await createServiceType(manager.ctx, { name: 'Audit service', defaultDurationMin: 60 });
    await updateServiceType(manager.ctx, type.id, { defaultDurationMin: 90 });
    const bay = await createBay(manager.ctx, { name: 'Audit bay' });
    await updateBay(manager.ctx, bay.id, { name: 'Audit bay 1' });
    await updateRules(manager.ctx, { requireRescheduleReason: false });
    await setWorkshopHours(manager.ctx, { intervals: [{ weekday: 1, start: '08:00', end: '17:00' }, { weekday: 2, start: '08:00', end: '17:00' }, { weekday: 3, start: '08:00', end: '17:00' }, { weekday: 4, start: '08:00', end: '17:00' }, { weekday: 5, start: '08:00', end: '17:00' }] });
    await setTechnicianSchedule(manager.ctx, tech.ctx.membership.id, { intervals: [] });
    await addTimeOff(manager.ctx, { membershipId: tech.ctx.membership.id, kind: 'LEAVE', startsAt: '2031-01-01T08:00:00Z', endsAt: '2031-01-02T08:00:00Z' });

    // bookings
    const b1 = await createBooking(advisor.ctx, { customerId: c.id, vehicleId: v.id, serviceTypeId: type.id, date: nextWeekday(50), time: '09:00', technicianMembershipId: tech.ctx.membership.id });
    await rescheduleBooking(advisor.ctx, b1.id, { date: nextWeekday(51), time: '09:00', reason: 'Parts' });
    await cancelBooking(advisor.ctx, b1.id, { reason: 'Changed mind' });
    const b2 = await createBooking(advisor.ctx, { customerId: c.id, vehicleId: v.id, serviceTypeId: type.id, date: nextWeekday(52), time: '09:00' });
    await ownerQuery("UPDATE bookings SET starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' WHERE id = $1", [b2.id]);
    await setBookingStatus(advisor.ctx, b2.id, { status: 'NO_SHOW' });
    const w = await addWaitingEntry(advisor.ctx, { customerId: c.id, vehicleId: v.id, serviceTypeId: type.id });
    await convertWaitingEntry(advisor.ctx, w.id, { date: nextWeekday(53), time: '09:00' });
    const series = await createRecurringSeries(advisor.ctx, { customerId: c.id, vehicleId: v.id, serviceLabel: 'Audit series', durationMin: 60, frequency: 'WEEKLY', startDate: nextWeekday(60), time: '11:00', occurrences: 2 });
    await cancelRecurringSeries(advisor.ctx, series.rule.id, {});
    const b3 = await createBooking(advisor.ctx, { customerId: c.id, vehicleId: v.id, serviceTypeId: type.id, date: nextWeekday(54), time: '09:00' });

    // the job
    const { job } = await checkInBooking(advisor.ctx, b3.id, { mileageKm: 10_450 });
    await assignTechnicians(advisor.ctx, job.id, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    await updateJob(advisor.ctx, job.id, { priority: 'HIGH' });
    await startInspection(tech.ctx, job.id);
    const items = (await ownerQuery('SELECT id FROM inspection_items WHERE inspection_id = (SELECT id FROM inspections WHERE job_id = $1) LIMIT 1', [job.id])).rows;
    await updateInspectionItem(tech.ctx, job.id, items[0]!.id, { status: 'CRITICAL' });
    await completeInspection(tech.ctx, job.id);
    const d = await createDiagnosis(tech.ctx, job.id, { findings: 'f', diagnosis: 'd' });
    await updateDiagnosis(tech.ctx, job.id, d.id, { symptoms: 's' });
    await confirmDiagnosis(tech.ctx, job.id, d.id);
    const work = await createRecommendedWork(tech.ctx, job.id, { description: 'Repair', priority: 'URGENT' });
    await changeJobStatus(tech.ctx, job.id, { status: 'DIAGNOSIS' });
    await changeJobStatus(tech.ctx, job.id, { status: 'AWAITING_APPROVAL' });
    await decideRecommendedWork(advisor.ctx, job.id, work.id, { decision: 'APPROVED', method: 'PHONE' });
    for (const s of ['APPROVED', 'IN_PROGRESS', 'QUALITY_CHECK'] as const) await changeJobStatus(tech.ctx, job.id, { status: s });
    await addJobPart(tech.ctx, job.id, { description: 'Part' });
    await addJobLabour(tech.ctx, job.id, { description: 'Labour', minutes: 30 });
    const note = await addJobNote(tech.ctx, job.id, { body: 'note' });
    await setJobNoteVisibility(tech.ctx, job.id, note.id, 'CUSTOMER');
    const photo = await addJobPhoto(tech.ctx, job.id, { data: PNG, filename: 'p.png' }, {});
    await setJobPhotoVisibility(tech.ctx, job.id, photo.id, 'CUSTOMER');
    await removeJobPhoto(manager.ctx, job.id, photo.id);
    await recordQualityCheck(manager.ctx, job.id, { passed: true, checklist: { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: 'na', requested_work_completed: true } });
    await changeJobStatus(manager.ctx, job.id, { status: 'COMPLETED' });
    await setVehicleArchived(manager.ctx, v.id, true);
    await setCustomerArchived(manager.ctx, c.id, true);

    const rows = (await ownerQuery('SELECT action, business_id, user_id FROM audit_logs WHERE business_id = $1', [ws.businessId])).rows;
    const actions = new Set(rows.map((r) => r.action as string));
    const expected = [
      'customer.created', 'customer.updated', 'customer.status_changed', 'customer.archived',
      'vehicle.created', 'vehicle.updated', 'vehicle.mileage_recorded', 'vehicle.mileage_corrected', 'vehicle.status_changed', 'vehicle.archived',
      'workshop.service_type_changed', 'workshop.bay_changed', 'workshop.settings_changed', 'workshop.hours_changed', 'workshop.technician_schedule_changed', 'workshop.technician_time_off_changed',
      'booking.created', 'booking.rescheduled', 'booking.cancelled', 'booking.no_show', 'booking.checked_in', 'waiting_list.added', 'waiting_list.booked', 'booking.recurring_created', 'booking.recurring_cancelled',
      'job.created', 'job.checked_in', 'job.technician_assigned', 'job.priority_changed', 'job.status_changed', 'job.quality_check',
      'inspection.started', 'inspection.updated', 'inspection.completed', 'diagnosis.recorded', 'diagnosis.updated', 'diagnosis.confirmed',
      'recommended_work.changed', 'recommended_work.decision', 'job.part_changed', 'job.labour_changed',
      'job.note_added', 'job.note_visibility_changed', 'job.photo_added', 'job.photo_visibility_changed', 'job.photo_removed',
    ];
    for (const a of expected) expect(actions, a).toContain(a);

    // All of it belongs to this business, and every event names the person who did it.
    expect(rows.every((r) => r.business_id === ws.businessId)).toBe(true);
    expect(rows.filter((r) => expected.includes(r.action as string)).every((r) => !!r.user_id)).toBe(true);
    const who = (action: string) => rows.filter((r) => r.action === action).map((r) => r.user_id);
    expect(who('job.quality_check')).toEqual([manager.ctx.user.id]);
    expect(who('recommended_work.decision')).toEqual([advisor.ctx.user.id]);
    expect(who('inspection.started')).toEqual([tech.ctx.user.id]);
    // and the timeline holds the real events, in order
    const tl = (await ownerQuery('SELECT type FROM activity_events WHERE job_id = $1 ORDER BY created_at, id', [job.id])).rows.map((r) => r.type as string);
    expect(tl[0]).toBe('job.created');
    expect(tl).toEqual(expect.arrayContaining(['job.checked_in', 'inspection.started', 'inspection.completed', 'diagnosis.recorded', 'work.recommended', 'work.decision', 'job.status_changed', 'job.quality_check']));
  }, 60_000);
});

describe('exports of Part 3 data', () => {
  it('contain only the exporting business’s rows and respect dataset permissions (pricing is separate)', async () => {
    const a = await createWorkspace('Export Part3 A');
    const b = await createWorkspace('Export Part3 B');
    const tech = await createMemberCtx(a, 'technician');
    const mgr = await createMemberCtx(a, 'manager');
    const sa = await seedCustomerVehicle(a, 'ExA');
    const sb = await seedCustomerVehicle(b, 'ExB');
    const { job } = await createJob(a.ctx, { customerId: sa.customer.id, vehicleId: sa.vehicle.id, primaryTechnicianMembershipId: tech.ctx.membership.id });
    await addJobPart(mgr.ctx, job.id, { description: 'Priced part', costCents: 100, sellPriceCents: 200 });
    await createJob(b.ctx, { customerId: sb.customer.id, vehicleId: sb.vehicle.id });

    for (const key of ['vehicles', 'jobs', 'vehicle_mileage', 'job_parts_labour_pricing']) {
      const ds = EXPORT_DATASETS.find((d) => d.key === key)!;
      const rowsA = (await withTenant(a.businessId, (tx) => ds.fetch(tx, a.businessId))) as { businessId: string }[];
      expect(rowsA.length, key).toBeGreaterThan(0);
      expect(rowsA.every((r) => r.businessId === a.businessId), key).toBe(true);
    }
    const recWork = EXPORT_DATASETS.find((d) => d.key === 'recommended_work')!;
    await createRecommendedWork(mgr.ctx, job.id, { description: 'Priced work', estimatedLabourCents: 5000, estimatedPartsCents: 7000 });
    const exported = (await withTenant(a.businessId, (tx) => recWork.fetch(tx, a.businessId))) as Record<string, unknown>[];
    expect(exported.length).toBeGreaterThan(0);
    expect(Object.keys(exported[0]!)).not.toContain('estimatedLabourCents');

    const techKeys = exportableDatasets(tech.ctx).map((d) => d.key);
    expect(techKeys).toEqual(expect.arrayContaining(['vehicles', 'jobs', 'bookings', 'customers']));
    expect(techKeys).not.toContain('job_parts_labour_pricing');
    expect(techKeys).not.toContain('audit');
    expect(exportableDatasets(mgr.ctx).map((d) => d.key)).toContain('job_parts_labour_pricing');
    void sb;
  });
});
