import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import {
  cancelBooking, createBooking, findFreeSlots, getBooking, getCalendar, listBookings, rescheduleBooking, setBookingStatus, updateBooking,
} from '@/server/bookings/service';
import { addWaitingEntry, cancelRecurringSeries, convertWaitingEntry, createRecurringSeries, listRecurringRules, listWaitingEntries } from '@/server/bookings/extras';
import { checkInBooking, createJob } from '@/server/jobcards/service';
import { createBay, listServiceTypes, updateRules, addTimeOff, setTechnicianSchedule } from '@/server/workshop/service';
import { listTimeline } from '@/server/activity/service';
import { drainJobs, createMemberCtx, createWorkspace, ownerQuery, sentTo, type TestWorkspace } from '../helpers/factory';
import { memberWithPermissions, nextSaturday, nextWeekday, seedCustomerVehicle } from '../helpers/workshop';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
let tech1: string;
let tech2: string;
let minorService: string; // 120 minutes
let diagnostic: string; // 60 minutes

beforeAll(async () => {
  ws = await createWorkspace('Bookings Workshop');
  tech1 = (await createMemberCtx(ws, 'technician')).ctx.membership.id;
  tech2 = (await createMemberCtx(ws, 'technician')).ctx.membership.id;
  const types = await listServiceTypes(ws.ctx);
  minorService = types.find((t) => t.name === 'Minor service')!.id;
  diagnostic = types.find((t) => t.name === 'Diagnostic')!.id;
});

const book = async (w: TestWorkspace, over: Record<string, unknown> = {}) => {
  const { customer, vehicle } = await seedCustomerVehicle(w, 'Bk');
  return createBooking(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: minorService, date: nextWeekday(1), time: '09:00', ...over });
};

describe('creating bookings', () => {
  it('creates a numbered booking for a customer and vehicle, with the duration of the service', async () => {
    const b = await book(ws, { date: nextWeekday(2), customerNotes: 'Squeaky brakes', internalNotes: 'Regular, pays cash' });
    expect(b.bookingNumber).toMatch(/^BKG-\d{6}$/);
    expect(b).toMatchObject({ businessId: ws.businessId, status: 'CONFIRMED', serviceLabel: 'Minor service', durationMin: 120, customerNotes: 'Squeaky brakes', internalNotes: 'Regular, pays cash' });
    expect(b.endsAt.getTime() - b.startsAt.getTime()).toBe(120 * 60_000);
    expect(b.startsAt.getUTCHours()).toBe(7); // 09:00 in Johannesburg is 07:00 UTC
    const full = await getBooking(ws.ctx, b.id);
    expect(full.events.map((e) => e.type)).toEqual(['created']);
  });

  it('refuses a vehicle that belongs to someone else, and unknown people or places', async () => {
    const a = await seedCustomerVehicle(ws, 'A');
    const b = await seedCustomerVehicle(ws, 'B');
    const base = { serviceTypeId: minorService, date: nextWeekday(3), time: '09:00' };
    await expect(createBooking(ws.ctx, { ...base, customerId: a.customer.id, vehicleId: b.vehicle.id })).rejects.toMatchObject({ status: 422, details: { vehicleId: expect.any(String) } });
    await expect(createBooking(ws.ctx, { ...base, customerId: a.customer.id, vehicleId: a.vehicle.id, technicianMembershipId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ status: 422 });
    await expect(createBooking(ws.ctx, { ...base, customerId: a.customer.id, vehicleId: a.vehicle.id, bayId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ status: 422 });
    await expect(createBooking(ws.ctx, { customerId: a.customer.id, vehicleId: a.vehicle.id, date: nextWeekday(3), time: '09:00' })).rejects.toMatchObject({ status: 422 }); // no service
  });

  it('only people who can edit bookings may override the duration; the service catalogue is untouched', async () => {
    const creator = await memberWithPermissions(ws, ['customer.view', 'vehicle.view', 'booking.view', 'booking.create']);
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Dur');
    const input = { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: diagnostic, date: nextWeekday(4), time: '10:00', durationMin: 180 };
    await expect(createBooking(creator.ctx, input)).rejects.toMatchObject({ status: 403 });
    expect((await createBooking(creator.ctx, { ...input, durationMin: 60 })).durationMin).toBe(60); // the default needs no override right
    const long = await createBooking(ws.ctx, { ...input, time: '12:00' });
    expect(long.durationMin).toBe(180);
    expect((await listServiceTypes(ws.ctx)).find((t) => t.id === diagnostic)!.defaultDurationMin).toBe(60);
  });
});

describe('availability, conflicts and capacity', () => {
  it('refuses to double-book a technician, but allows back-to-back appointments', async () => {
    const date = nextWeekday(5);
    const first = await book(ws, { date, time: '09:00', technicianMembershipId: tech1 }); // 09:00-11:00
    await expect(book(ws, { date, time: '10:00', technicianMembershipId: tech1 })).rejects.toMatchObject({ status: 409, details: { conflicts: [{ code: 'TECHNICIAN_BUSY', bookingId: first.id }] } });
    await expect(book(ws, { date, time: '09:30', technicianMembershipId: tech1 })).rejects.toMatchObject({ status: 409 });
    expect((await book(ws, { date, time: '11:00', technicianMembershipId: tech1 })).status).toBe('CONFIRMED');
    expect((await book(ws, { date, time: '09:00', technicianMembershipId: tech2 })).status).toBe('CONFIRMED');
  });

  it('two people booking the same technician at the same instant: exactly one wins', async () => {
    const date = nextWeekday(6);
    const customers = await Promise.all([1, 2, 3, 4, 5].map(() => seedCustomerVehicle(ws, 'Race')));
    const results = await Promise.allSettled(customers.map((c) => createBooking(ws.ctx, { customerId: c.customer.id, vehicleId: c.vehicle.id, serviceTypeId: minorService, date, time: '13:00', technicianMembershipId: tech1 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const n = await ownerQuery("SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND technician_membership_id = $2 AND starts_at = $3", [ws.businessId, tech1, (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ startsAt: Date }>).value.startsAt]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('respects opening hours; only a calendar manager can knowingly book outside them', async () => {
    const sat = nextSaturday();
    await expect(book(ws, { date: sat, time: '09:00' })).rejects.toMatchObject({ status: 409, details: { conflicts: [{ code: 'OUTSIDE_HOURS' }] } });
    await expect(book(ws, { date: nextWeekday(7), time: '16:00' })).rejects.toMatchObject({ status: 409 }); // 2h service would run past 17:00
    await expect(book(ws, { date: sat, time: '09:00', allowOutsideHours: true })).resolves.toMatchObject({ status: 'CONFIRMED' });
    const clerk = await memberWithPermissions(ws, ['customer.view', 'vehicle.view', 'booking.view', 'booking.create']);
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Out');
    await expect(createBooking(clerk.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: diagnostic, date: sat, time: '09:00', allowOutsideHours: true })).rejects.toMatchObject({ status: 403 });
  });

  it('respects a technician’s own hours and their leave', async () => {
    const w = await createWorkspace('Hours Workshop');
    const t = (await createMemberCtx(w, 'technician')).ctx.membership.id;
    const date = nextWeekday(1);
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    await setTechnicianSchedule(w.ctx, t, { intervals: [{ weekday: wd, start: '10:00', end: '14:00' }] });
    await expect(book(w, { date, time: '08:00', serviceTypeId: undefined, serviceLabel: 'Quick check', durationMin: 60, technicianMembershipId: t })).rejects.toMatchObject({ status: 409, details: { conflicts: [{ code: 'TECHNICIAN_OFF' }] } });
    await expect(book(w, { date, time: '10:00', serviceLabel: 'Quick check', durationMin: 60, serviceTypeId: undefined, technicianMembershipId: t })).resolves.toBeTruthy();
    const date2 = nextWeekday(2);
    await addTimeOff(w.ctx, { membershipId: t, kind: 'LEAVE', startsAt: `${date2}T00:00:00+02:00`, endsAt: `${date2}T23:59:00+02:00`, reason: 'Family' });
    await expect(book(w, { date: date2, time: '09:00', serviceLabel: 'Quick check', durationMin: 60, serviceTypeId: undefined, technicianMembershipId: t })).rejects.toMatchObject({ status: 409, details: { conflicts: expect.arrayContaining([expect.objectContaining({ code: 'TECHNICIAN_OFF', message: expect.stringContaining('on leave') })]) } });
  });

  it('enforces the workshop’s maximum concurrent jobs and its bays', async () => {
    const w = await createWorkspace('Capacity Workshop');
    const date = nextWeekday(1);
    await updateRules(w.ctx, { maxConcurrentJobs: 2 });
    await book(w, { date, time: '09:00', serviceTypeId: undefined, serviceLabel: 'A', durationMin: 60 });
    await book(w, { date, time: '09:00', serviceTypeId: undefined, serviceLabel: 'B', durationMin: 60 });
    await expect(book(w, { date, time: '09:30', serviceTypeId: undefined, serviceLabel: 'C', durationMin: 30 })).rejects.toMatchObject({ status: 409, details: { conflicts: [{ code: 'CAPACITY_FULL' }] } });
    expect((await book(w, { date, time: '10:00', serviceTypeId: undefined, serviceLabel: 'D', durationMin: 60 })).status).toBe('CONFIRMED');

    const b = await createWorkspace('Bay Workshop');
    const bay = await createBay(b.ctx, { name: 'Bay 1' });
    await book(b, { date, time: '09:00', serviceTypeId: undefined, serviceLabel: 'X', durationMin: 60, bayId: bay.id });
    await expect(book(b, { date, time: '09:30', serviceTypeId: undefined, serviceLabel: 'Y', durationMin: 60, bayId: bay.id })).rejects.toMatchObject({ status: 409 });
    expect(await ownerQuery('SELECT 1 FROM bays WHERE id = $1', [bay.id])).toBeTruthy();
  });

  it('the database itself stops one bay holding two live appointments', async () => {
    const w = await createWorkspace('Bay Constraint Workshop');
    const bay = await createBay(w.ctx, { name: 'Lift A' });
    const a = await book(w, { date: nextWeekday(1), time: '09:00', serviceTypeId: undefined, serviceLabel: 'A', durationMin: 60, bayId: bay.id });
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Direct');
    await expect(
      ownerQuery(
        `INSERT INTO bookings (business_id, booking_number, customer_id, vehicle_id, service_label, starts_at, ends_at, duration_min, bay_id, status, updated_at)
         VALUES ($1, 'BKG-X', $2, $3, 'Sneaky', $4, $5, 60, $6, 'CONFIRMED', now())`,
        [w.businessId, customer.id, vehicle.id, new Date(a.startsAt.getTime() + 30 * 60_000), new Date(a.endsAt.getTime() + 30 * 60_000), bay.id],
      ),
    ).rejects.toThrow(/bookings_bay_no_overlap/);
  });

  it('lists the free start times for a day', async () => {
    const w = await createWorkspace('Slots Workshop');
    const date = nextWeekday(1);
    await book(w, { date, time: '09:00', serviceTypeId: undefined, serviceLabel: 'Busy', durationMin: 60 });
    await updateRules(w.ctx, { maxConcurrentJobs: 1 });
    const { slots } = await findFreeSlots(w.ctx, { date, durationMin: 60, stepMin: 30 });
    expect(slots[0]).toBe('08:00');
    expect(slots).not.toContain('08:30'); // would overlap the 09:00 booking
    expect(slots).not.toContain('09:00');
    expect(slots).toContain('10:00');
    expect(slots).toContain('16:00');
    expect(slots).not.toContain('16:30'); // would run past closing
  });
});

describe('rescheduling and cancelling', () => {
  it('moves a booking, keeping the old time, new time, who and why, and tells the customer', async () => {
    const date = nextWeekday(8);
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Move');
    const b = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: minorService, date, time: '09:00', technicianMembershipId: tech2 });
    const moved = await rescheduleBooking(ws.ctx, b.id, { date: nextWeekday(9), time: '14:00', reason: 'Parts delayed' });
    expect(moved.status).toBe('RESCHEDULED');
    expect(moved.startsAt.toISOString()).not.toBe(b.startsAt.toISOString());
    const full = await getBooking(ws.ctx, b.id);
    const ev = full.events.find((e) => e.type === 'rescheduled')!;
    expect(ev).toMatchObject({ reason: 'Parts delayed', userId: ws.ctx.user.id, fromStartsAt: b.startsAt, toStartsAt: moved.startsAt, fromStatus: 'CONFIRMED', toStatus: 'RESCHEDULED' });
    const audit = await ownerQuery("SELECT before, after, metadata FROM audit_logs WHERE resource_id = $1 AND action = 'booking.rescheduled'", [b.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({ reason: 'Parts delayed' });
    await drainJobs();
    expect(sentTo(customer.email!).some((m) => /was moved/.test(m.subject))).toBe(true);
    expect((await listTimeline(ws.ctx, { customerId: customer.id }, {})).items.some((e) => e.type === 'booking.rescheduled')).toBe(true);
  });

  it('will not move a booking into a conflict, or to the time it already has', async () => {
    const date = nextWeekday(10);
    const a = await book(ws, { date, time: '09:00', technicianMembershipId: tech1 });
    const b = await book(ws, { date, time: '13:00', technicianMembershipId: tech1 });
    await expect(rescheduleBooking(ws.ctx, b.id, { date, time: '10:00' })).rejects.toMatchObject({ status: 409 });
    await expect(rescheduleBooking(ws.ctx, a.id, { date, time: '09:00' })).rejects.toMatchObject({ status: 422 });
    expect((await getBooking(ws.ctx, b.id)).startsAt.toISOString()).toBe(b.startsAt.toISOString()); // unchanged
    expect((await rescheduleBooking(ws.ctx, a.id, { date, time: '09:30' })).status).toBe('RESCHEDULED'); // overlapping only itself is fine
  });

  it('can require a reason, and can switch the customer email off', async () => {
    const w = await createWorkspace('Reason Workshop');
    await updateRules(w.ctx, { requireRescheduleReason: true, notifyCustomerReschedule: false });
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Rs');
    const b = await createBooking(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Check', durationMin: 60, date: nextWeekday(1), time: '09:00' });
    await expect(rescheduleBooking(w.ctx, b.id, { date: nextWeekday(2), time: '09:00' })).rejects.toMatchObject({ status: 422, details: { reason: expect.any(String) } });
    await rescheduleBooking(w.ctx, b.id, { date: nextWeekday(2), time: '09:00', reason: 'Customer asked' });
    await drainJobs();
    expect(sentTo(customer.email!).filter((m) => /was moved/.test(m.subject))).toHaveLength(0);
  });

  it('cancels with a reason, frees the slot, and cannot be cancelled twice', async () => {
    const date = nextWeekday(11);
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Cx');
    const b = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: minorService, date, time: '09:00', technicianMembershipId: tech1 });
    const gone = await cancelBooking(ws.ctx, b.id, { reason: 'Customer sold the car' });
    expect(gone).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer sold the car', cancelledById: ws.ctx.user.id });
    await expect(cancelBooking(ws.ctx, b.id)).rejects.toMatchObject({ status: 409 });
    await expect(rescheduleBooking(ws.ctx, b.id, { date, time: '11:00' })).rejects.toMatchObject({ status: 409 });
    expect((await book(ws, { date, time: '09:00', technicianMembershipId: tech1 })).status).toBe('CONFIRMED'); // the slot is free again
    await drainJobs();
    expect(sentTo(customer.email!).some((m) => /was cancelled/.test(m.subject))).toBe(true);
  });

  it('no-shows only after the start time; Completed only happens when the job completes; status changes are audited', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Ns');
    const b = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: diagnostic, date: nextWeekday(12), time: '09:00' });
    await expect(setBookingStatus(ws.ctx, b.id, { status: 'NO_SHOW' })).rejects.toMatchObject({ status: 409 });
    await expect(setBookingStatus(ws.ctx, b.id, { status: 'COMPLETED' })).rejects.toMatchObject({ status: 422 });
    await ownerQuery("UPDATE bookings SET starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' WHERE id = $1", [b.id]);
    expect((await setBookingStatus(ws.ctx, b.id, { status: 'NO_SHOW', reason: 'Never arrived' })).status).toBe('NO_SHOW');
    const audit = await ownerQuery("SELECT action FROM audit_logs WHERE resource_id = $1 AND action = 'booking.no_show'", [b.id]);
    expect(audit.rows).toHaveLength(1);
    const r = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: diagnostic, date: nextWeekday(13), time: '09:00', status: 'REQUESTED' });
    expect((await setBookingStatus(ws.ctx, r.id, { status: 'CONFIRMED' })).status).toBe('CONFIRMED');
    expect((await setBookingStatus(ws.ctx, r.id, { status: 'REMINDER_SENT' })).reminderSentAt).toBeInstanceOf(Date);
  });

  it('edits notes and technician, re-checking the diary', async () => {
    const date = nextWeekday(14);
    const a = await book(ws, { date, time: '09:00', technicianMembershipId: tech1 });
    const b = await book(ws, { date, time: '09:00', technicianMembershipId: tech2 });
    await expect(updateBooking(ws.ctx, b.id, { technicianMembershipId: tech1 })).rejects.toMatchObject({ status: 409 });
    expect((await updateBooking(ws.ctx, a.id, { internalNotes: 'Needs the lift' })).internalNotes).toBe('Needs the lift');
    expect((await updateBooking(ws.ctx, a.id, { durationMin: 60 })).endsAt.getTime() - a.startsAt.getTime()).toBe(60 * 60_000);
  });
});

describe('walk-ins and booking → job', () => {
  it('a walk-in becomes a job without a fake booking, arrival and mileage recorded', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Walk');
    const { job, created } = await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, isWalkIn: true, complaint: 'Overheating', mileageKm: 51_500, fuelLevel: 'HALF', existingDamage: 'Scratch on left door', keysAccessories: '1 key, spare wheel' });
    expect(created).toBe(true);
    expect(job).toMatchObject({ bookingId: null, status: 'CHECKED_IN', isWalkIn: true, complaint: 'Overheating', mileageInKm: 51_500, businessId: ws.businessId });
    expect(job.jobNumber).toMatch(/^JOB-\d{7}$/);
    const ci = await ownerQuery('SELECT arrived_at, mileage_km, fuel_level, existing_damage, keys_accessories FROM job_check_ins WHERE job_id = $1', [job.id]);
    expect(ci.rows[0]).toMatchObject({ mileage_km: 51_500, fuel_level: 'HALF', existing_damage: 'Scratch on left door', keys_accessories: '1 key, spare wheel' });
    expect(ci.rows[0]!.arrived_at).toBeInstanceOf(Date);
    const miles = await ownerQuery("SELECT source, mileage_km FROM vehicle_mileage_log WHERE vehicle_id = $1 ORDER BY recorded_at", [vehicle.id]);
    expect(miles.rows.map((r) => r.source)).toEqual(['CREATED', 'CHECK_IN']);
    expect(await ownerQuery('SELECT count(*)::int AS n FROM bookings WHERE vehicle_id = $1', [vehicle.id])).toMatchObject({ rows: [{ n: 0 }] });
  });

  it('checking a booking in opens its job with the booking’s details carried across', async () => {
    const date = nextWeekday(15);
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Conv');
    const b = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: minorService, date, time: '09:00', technicianMembershipId: tech1, customerNotes: 'Service plus check the aircon' });
    const { job, created } = await checkInBooking(ws.ctx, b.id, { mileageKm: 50_200, fuelLevel: 'QUARTER' });
    expect(created).toBe(true);
    expect(job).toMatchObject({
      bookingId: b.id, customerId: customer.id, vehicleId: vehicle.id, status: 'CHECKED_IN', serviceTypeId: minorService, serviceLabel: 'Minor service',
      primaryTechnicianMembershipId: tech1, complaint: 'Service plus check the aircon', mileageInKm: 50_200,
    });
    expect(job.estimatedCompletionAt!.toISOString()).toBe(b.endsAt.toISOString());
    const after = await getBooking(ws.ctx, b.id);
    expect(after).toMatchObject({ status: 'CHECKED_IN', job: { id: job.id } });
    expect(after.checkedInAt).toBeInstanceOf(Date);
    expect(after.events.map((e) => e.type)).toEqual(['created', 'checked_in']);
  });

  it('checking in twice — even at the same instant — never creates a second job', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Dup');
    const b = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: diagnostic, date: nextWeekday(16), time: '09:00' });
    const results = await Promise.all([1, 2, 3, 4].map(() => checkInBooking(ws.ctx, b.id, { mileageKm: 50_100 })));
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await checkInBooking(ws.ctx, b.id, {})).created).toBe(false);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM job_cards WHERE booking_id = $1', [b.id])).rows[0]!.n).toBe(1);
    // and the database refuses a second job for the booking even if the application did not
    await expect(ownerQuery("INSERT INTO job_cards (business_id, job_number, customer_id, vehicle_id, booking_id, updated_at) VALUES ($1, 'JOB-X', $2, $3, $4, now())", [ws.businessId, customer.id, vehicle.id, b.id])).rejects.toThrow(/job_cards_booking_id_business_id_key/);
  });

  it('cancelled bookings cannot be checked in; a job can be opened ahead of arrival and checked in later', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Pre');
    const b = await createBooking(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: diagnostic, date: nextWeekday(17), time: '09:00' });
    const pre = await createJob(ws.ctx, { bookingId: b.id, arrived: false });
    expect(pre.job.status).toBe('BOOKED');
    expect((await getBooking(ws.ctx, b.id)).status).toBe('CONFIRMED'); // not arrived yet
    const arrived = await checkInBooking(ws.ctx, b.id, { mileageKm: 50_050 });
    expect(arrived.job).toMatchObject({ id: pre.job.id, status: 'CHECKED_IN', mileageInKm: 50_050 });
    expect(arrived.created).toBe(false);

    const c2 = await seedCustomerVehicle(ws, 'Gone');
    const b2 = await createBooking(ws.ctx, { customerId: c2.customer.id, vehicleId: c2.vehicle.id, serviceTypeId: diagnostic, date: nextWeekday(18), time: '09:00' });
    await cancelBooking(ws.ctx, b2.id);
    await expect(checkInBooking(ws.ctx, b2.id, {})).rejects.toMatchObject({ status: 409 });
  });

  it('a job can only be opened for the customer and vehicle that belong together', async () => {
    const a = await seedCustomerVehicle(ws, 'JA');
    const b = await seedCustomerVehicle(ws, 'JB');
    await expect(createJob(ws.ctx, { customerId: a.customer.id, vehicleId: b.vehicle.id })).rejects.toMatchObject({ status: 422 });
    await expect(createJob(ws.ctx, { customerId: a.customer.id })).rejects.toMatchObject({ status: 422 });
  });
});

describe('waiting list and recurring bookings', () => {
  it('moves a waiting customer into a booking only when staff choose the slot', async () => {
    const date = nextWeekday(19);
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Wait');
    const entry = await addWaitingEntry(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: diagnostic, preferredDate: date, preferredFrom: '08:00', preferredTo: '12:00', contactPreference: 'WHATSAPP', notes: 'Any morning' });
    expect(entry.status).toBe('WAITING');
    expect((await listWaitingEntries(ws.ctx, {})).items.map((e) => e.id)).toContain(entry.id);
    expect(await ownerQuery('SELECT count(*)::int AS n FROM bookings WHERE customer_id = $1', [customer.id])).toMatchObject({ rows: [{ n: 0 }] }); // nothing booked automatically
    const booking = await convertWaitingEntry(ws.ctx, entry.id, { date, time: '08:30' });
    expect(booking).toMatchObject({ customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Diagnostic' });
    await expect(convertWaitingEntry(ws.ctx, entry.id, { date, time: '09:30' })).rejects.toMatchObject({ status: 409 });
    expect((await listWaitingEntries(ws.ctx, { status: 'BOOKED' })).items[0]).toMatchObject({ id: entry.id, bookingId: booking.id });
  });

  it('creates a real booking per occurrence and reports the ones that could not be booked', async () => {
    const w = await createWorkspace('Recurring Workshop');
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Fleet');
    const t = (await createMemberCtx(w, 'technician')).ctx.membership.id;
    const start = nextWeekday(1);
    // Block the second week so that occurrence cannot be booked.
    const second = new Date(`${start}T00:00:00Z`);
    second.setUTCDate(second.getUTCDate() + 7);
    await book(w, { date: second.toISOString().slice(0, 10), time: '09:00', serviceTypeId: undefined, serviceLabel: 'Blocker', durationMin: 60, technicianMembershipId: t });
    const r = await createRecurringSeries(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Fleet service', durationMin: 60, technicianMembershipId: t, frequency: 'WEEKLY', intervalCount: 1, startDate: start, time: '09:00', occurrences: 4 });
    expect(r.created).toHaveLength(3);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reasons[0]).toMatch(/already has booking/);
    expect(r.created.every((b) => b.recurringRuleId === r.rule.id && b.bookingNumber.startsWith('BKG-'))).toBe(true);
    expect(new Set(r.created.map((b) => b.id)).size).toBe(3); // distinct records, not one record for many dates
    expect((await listRecurringRules(w.ctx))[0]).toMatchObject({ id: r.rule.id, upcomingBookings: 3 });

    const stopped = await cancelRecurringSeries(w.ctx, r.rule.id, { reason: 'Contract ended' });
    expect(stopped.cancelled).toBe(3);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM bookings WHERE recurring_rule_id = $1 AND status = 'CANCELLED'", [r.rule.id])).rows[0]!.n).toBe(3);
    await expect(createRecurringSeries(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Open ended', frequency: 'WEEKLY', startDate: start, time: '09:00' })).rejects.toMatchObject({ status: 422 });
  });
});

describe('calendar, filters and pagination', () => {
  it('returns the right range for day, week and month, and filters by technician and status', async () => {
    const w = await createWorkspace('Calendar Workshop');
    const t = (await createMemberCtx(w, 'technician')).ctx.membership.id;
    const d1 = nextWeekday(1);
    const d2 = nextWeekday(20);
    const a = await book(w, { date: d1, time: '09:00', serviceTypeId: undefined, serviceLabel: 'One', durationMin: 60, technicianMembershipId: t });
    const b = await book(w, { date: d2, time: '09:00', serviceTypeId: undefined, serviceLabel: 'Two', durationMin: 60 });
    const day = await getCalendar(w.ctx, { view: 'day', date: d1 });
    expect(day.items.map((i) => i.id)).toEqual([a.id]);
    expect(day.items[0]).toMatchObject({ technicianName: expect.any(String), customer: { name: expect.any(String) }, vehicle: { registration: expect.any(String) } });
    const week = await getCalendar(w.ctx, { view: 'week', date: d1 });
    expect(week.days).toBe(7);
    expect(week.items.map((i) => i.id)).toContain(a.id);
    const month = await getCalendar(w.ctx, { view: 'month', date: d1 });
    expect(month.days).toBe(42);
    expect(month.items.map((i) => i.id)).toContain(a.id);
    expect((await getCalendar(w.ctx, { view: 'week', date: d2, technicianId: t })).items).toEqual([]);
    expect((await getCalendar(w.ctx, { view: 'day', date: d2, status: 'CONFIRMED' })).items.map((i) => i.id)).toEqual([b.id]);
    expect((await getCalendar(w.ctx, { view: 'day', date: d2, status: 'CANCELLED' })).items).toEqual([]);
  });

  it('lists bookings with search, filters and pagination that agree with each other', async () => {
    const w = await createWorkspace('Booking List Workshop');
    const dates = [nextWeekday(1), nextWeekday(2), nextWeekday(3)];
    for (const [i, d] of dates.entries()) for (const h of ['09:00', '11:00', '13:00']) await book(w, { date: d, time: h, serviceTypeId: undefined, serviceLabel: ['Alpha', 'Beta', 'Gamma'][i]!, durationMin: 60 });
    const all = await listBookings(w.ctx, { pageSize: 4 });
    expect(all.meta).toMatchObject({ total: 9, totalPages: 3 });
    const ids = new Set<string>();
    for (const p of [1, 2, 3]) for (const i of (await listBookings(w.ctx, { pageSize: 4, page: p })).items) ids.add(i.id);
    expect(ids.size).toBe(9);
    expect((await listBookings(w.ctx, { from: dates[1], to: dates[1] })).meta.total).toBe(3);
    expect((await listBookings(w.ctx, { from: dates[1], to: dates[2], pageSize: 2 })).meta.total).toBe(6);
    expect((await listBookings(w.ctx, { q: 'Gamma' })).meta.total).toBe(3);
    expect((await listBookings(w.ctx, { q: 'BKG-000001' })).meta.total).toBe(1);
    expect((await listBookings(w.ctx, { status: 'CANCELLED' })).meta.total).toBe(0);
    await expect(listBookings(w.ctx, { from: '2026-13-45' })).rejects.toMatchObject({ status: 422 });
  });
});
