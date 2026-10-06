import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { createBooking } from '@/server/bookings/service';
import { addWaitingEntry, createRecurringSeries } from '@/server/bookings/extras';
import { createJob } from '@/server/jobcards/service';
import { createDiagnosis, createRecommendedWork, startInspection } from '@/server/jobcards/work';
import { addJobPart, addJobPhoto } from '@/server/jobcards/items';
import { createBay, createServiceType } from '@/server/workshop/service';
import { addInterval } from '@/server/vehicles/insights';
import { globalSearch } from '@/server/search/service';
import { EXPORT_DATASETS } from '@/server/exports/registry';
import { withTenant } from '@/server/db/client';
import { GET as vehicleRoute, PATCH as patchVehicleRoute } from '@/app/api/v1/vehicles/[id]/route';
import { GET as vehiclesRoute, POST as createVehicleRoute } from '@/app/api/v1/vehicles/route';
import { GET as jobRoute, PATCH as patchJobRoute } from '@/app/api/v1/jobs/[id]/route';
import { GET as jobsRoute, POST as createJobRoute } from '@/app/api/v1/jobs/route';
import { POST as statusRoute } from '@/app/api/v1/jobs/[id]/status/route';
import { POST as assignRoute } from '@/app/api/v1/jobs/[id]/assign/route';
import { POST as photoRoute } from '@/app/api/v1/jobs/[id]/photos/route';
import { GET as reportRoute } from '@/app/api/v1/jobs/[id]/report/route';
import { GET as bookingRoute } from '@/app/api/v1/bookings/[id]/route';
import { POST as createBookingRoute } from '@/app/api/v1/bookings/route';
import { POST as rescheduleRoute } from '@/app/api/v1/bookings/[id]/reschedule/route';
import { POST as checkInRoute } from '@/app/api/v1/bookings/[id]/check-in/route';
import { GET as calendarRoute } from '@/app/api/v1/bookings/calendar/route';
import { GET as myJobsRoute } from '@/app/api/v1/jobs/mine/route';
import { GET as customerTimelineRoute } from '@/app/api/v1/customers/[id]/timeline/route';
import { GET as customersRoute } from '@/app/api/v1/customers/route';
import { call } from '../helpers/http';
import { createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { nextWeekday, seedCustomerVehicle } from '../helpers/workshop';
import { VALID_PNG } from '../helpers/images';

afterAll(disconnectPrisma);

const PNG = VALID_PNG;
const NOPE = '00000000-0000-4000-8000-000000000000';

let A: TestWorkspace;
let B: TestWorkspace;
const b: Record<string, string> = {};

beforeAll(async () => {
  A = await createWorkspace('Isolation A Motors');
  B = await createWorkspace('Isolation B Motors');
  const { customer, vehicle } = await seedCustomerVehicle(B, 'Zyxwv');
  await ownerQuery("UPDATE customers SET name = 'Quillfeather Zyxwv', first_name = 'Quillfeather', last_name = 'Zyxwv' WHERE id = $1", [customer.id]);
  const tech = await createMemberCtx(B, 'technician');
  const booking = await createBooking(B.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Secret service', durationMin: 60, date: nextWeekday(1), time: '09:00' });
  const { job } = await createJob(B.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Quillfeather complaint', primaryTechnicianMembershipId: tech.ctx.membership.id });
  await startInspection(B.ctx, job.id);
  const diag = await createDiagnosis(B.ctx, job.id, { findings: 'Secret finding' });
  const work = await createRecommendedWork(B.ctx, job.id, { description: 'Secret repair' });
  const part = await addJobPart(B.ctx, job.id, { description: 'Secret part' });
  const photo = await addJobPhoto(B.ctx, job.id, { data: PNG, filename: 'secret.png' }, {});
  const waiting = await addWaitingEntry(B.ctx, { customerId: customer.id, serviceLabel: 'Waiting for secret' });
  const rec = await createRecurringSeries(B.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Recurring secret', durationMin: 60, frequency: 'WEEKLY', startDate: nextWeekday(2), time: '10:00', occurrences: 2 });
  const bay = await createBay(B.ctx, { name: 'Secret bay' });
  const type = await createServiceType(B.ctx, { name: 'Secret service type', defaultDurationMin: 30 });
  const interval = await addInterval(B.ctx, vehicle.id, { name: 'Secret interval', everyKm: 5000, lastServiceKm: 1000 });
  Object.assign(b, {
    customer: customer.id, vehicle: vehicle.id, booking: booking.id, job: job.id, diag: diag.id, work: work.id, part: part.id, photo: photo.id,
    waiting: waiting.id, rule: rec.rule.id, bay: bay.id, type: type.id, interval: interval.id,
  });
});

describe('another business cannot read or change any Part 3 record — expected: 404 and nothing changes', () => {
  it('reads: vehicle, booking, job and timelines look exactly like records that do not exist', async () => {
    for (const [handler, id] of [[vehicleRoute, b.vehicle], [bookingRoute, b.booking], [jobRoute, b.job]] as const) {
      const real = await call(handler, { token: A.ctx.token, params: { id: id! } });
      const fake = await call(handler, { token: A.ctx.token, params: { id: NOPE } });
      expect(real.status).toBe(404);
      expect(real.body.error.message).toBe(fake.body.error.message);
      expect(JSON.stringify(real.body)).not.toMatch(/Quillfeather|Secret|Zyxwv/i);
    }
    expect((await call(customerTimelineRoute, { token: A.ctx.token, params: { id: b.customer! } })).body.data).toEqual([]);
  });

  it('writes: every mutation of a foreign record is refused and the record is untouched', async () => {
    const attempts = await Promise.all([
      call(patchVehicleRoute, { method: 'PATCH', token: A.ctx.token, params: { id: b.vehicle! }, body: { colour: 'HACKED' } }),
      call(patchJobRoute, { method: 'PATCH', token: A.ctx.token, params: { id: b.job! }, body: { complaint: 'HACKED' } }),
      call(statusRoute, { token: A.ctx.token, params: { id: b.job! }, body: { status: 'INSPECTION' } }),
      call(assignRoute, { token: A.ctx.token, params: { id: b.job! }, body: { primaryTechnicianMembershipId: A.ctx.membership.id } }),
      call(rescheduleRoute, { token: A.ctx.token, params: { id: b.booking! }, body: { date: nextWeekday(5), time: '10:00' } }),
      call(checkInRoute, { token: A.ctx.token, params: { id: b.booking! }, body: {} }),
      call(photoRoute, { token: A.ctx.token, params: { id: b.job! }, form: (() => { const f = new FormData(); f.set('file', new File([PNG], 'x.png', { type: 'image/png' })); return f; })() }),
    ]);
    for (const r of attempts) expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect((await ownerQuery('SELECT colour FROM vehicles WHERE id = $1', [b.vehicle])).rows[0]!.colour).not.toBe('HACKED');
    expect((await ownerQuery('SELECT complaint, status FROM job_cards WHERE id = $1', [b.job])).rows[0]).toMatchObject({ complaint: 'Quillfeather complaint', status: 'INSPECTION' });
    expect((await ownerQuery("SELECT status FROM bookings WHERE id = $1", [b.booking])).rows[0]!.status).toBe('CONFIRMED');
    expect((await ownerQuery('SELECT count(*)::int AS n FROM job_photos WHERE job_id = $1', [b.job])).rows[0]!.n).toBe(1);
  });

  it('lists and search never include them', async () => {
    for (const handler of [vehiclesRoute, jobsRoute, customersRoute]) {
      const r = await call(handler, { token: A.ctx.token, query: { q: 'Quillfeather' } });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([]);
    }
    const cal = await call(calendarRoute, { token: A.ctx.token, query: { view: 'month', date: nextWeekday(1) } });
    expect(cal.body.data.items).toEqual([]);
    for (const term of ['Quillfeather', 'Zyxwv', 'Secret']) expect(await globalSearch(A.ctx, { q: term })).toEqual([]);
    // …while the owning business finds them.
    const found = await globalSearch(B.ctx, { q: 'Quillfeather' });
    expect(found.map((g) => g.key).sort()).toEqual(['bookings', 'customers', 'jobs', 'vehicles']); // all four match by owner name
    expect((await globalSearch(B.ctx, { q: 'Zyxwv' })).map((g) => g.key)).toEqual(expect.arrayContaining(['customers', 'vehicles', 'jobs', 'bookings']));
  });

  it('the database rows themselves are invisible without the right tenant context', async () => {
    const tables = ['vehicles', 'bookings', 'job_cards', 'inspections', 'inspection_items', 'diagnoses', 'recommended_work_items', 'job_parts', 'job_photos', 'waiting_list_entries', 'recurring_booking_rules', 'bays', 'service_types', 'service_intervals', 'activity_events', 'booking_events', 'vehicle_mileage_log'];
    const { prisma } = await import('@/server/db/client');
    for (const t of tables) {
      const none = await prisma().$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${t}`);
      expect(Number(none[0]!.n), `${t} without tenant`).toBe(0);
      const asA = await withTenant(A.businessId, (tx) => tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${t} WHERE business_id = '${B.businessId}'`));
      expect(Number(asA[0]!.n), `${t} as other tenant`).toBe(0);
    }
  });

  it('foreign ids cannot be smuggled into the caller’s own records (composite keys and server-side checks)', async () => {
    const mine = await seedCustomerVehicle(A, 'Mine');
    await expect(ownerQuery('INSERT INTO vehicles (business_id, customer_id, registration, registration_norm, updated_at) VALUES ($1, $2, $3, $3, now())', [A.businessId, b.customer, 'SMUGGLE1'])).rejects.toThrow(/foreign key/);
    const viaApi = await call(createVehicleRoute, { token: A.ctx.token, body: { customerId: b.customer, registration: 'SMUGGLE2 GP' } });
    expect(viaApi.status).toBe(422);
    const bookViaApi = await call(createBookingRoute, { token: A.ctx.token, body: { customerId: mine.customer.id, vehicleId: b.vehicle, serviceLabel: 'x', date: nextWeekday(3), time: '09:00' } });
    expect(bookViaApi.status).toBe(422);
    const jobViaApi = await call(createJobRoute, { token: A.ctx.token, body: { customerId: mine.customer.id, vehicleId: mine.vehicle.id, bookingId: b.booking } });
    expect(jobViaApi.status).toBe(404);
    const jobBayApi = await call(createJobRoute, { token: A.ctx.token, body: { customerId: mine.customer.id, vehicleId: mine.vehicle.id, bayId: b.bay } });
    expect(jobBayApi.status).toBe(422);
    await expect(ownerQuery('INSERT INTO job_cards (business_id, job_number, customer_id, vehicle_id, updated_at) VALUES ($1, $2, $3, $4, now())', [A.businessId, 'JOB-FOREIGN', b.customer, mine.vehicle.id])).rejects.toThrow(/foreign key/);
    await expect(ownerQuery('INSERT INTO job_parts (business_id, job_id, description, updated_at) VALUES ($1, $2, $3, now())', [A.businessId, b.job, 'x'])).rejects.toThrow(/foreign key/);
  });

  it('exports contain only the exporting business’s rows', async () => {
    const wantedKeys = ['customers'];
    for (const key of wantedKeys) {
      const ds = EXPORT_DATASETS.find((d) => d.key === key)!;
      const rows = await withTenant(A.businessId, (tx) => ds.fetch(tx, A.businessId));
      expect(JSON.stringify(rows)).not.toMatch(/Quillfeather/);
    }
  });
});

describe('permissions are enforced by the API, not by hidden buttons', () => {
  it('requires a signed-in session and a same-origin request', async () => {
    expect((await call(jobsRoute, {})).status).toBe(401);
    expect((await call(createJobRoute, { token: A.ctx.token, body: {}, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('a technician can work but cannot create bookings, assign jobs, or reach financial overrides', async () => {
    const tech = await createMemberCtx(A, 'technician');
    const mine = await seedCustomerVehicle(A, 'Perm');
    const { job } = await createJob(A.ctx, { customerId: mine.customer.id, vehicleId: mine.vehicle.id });
    expect((await call(jobsRoute, { token: tech.ctx.token })).status).toBe(200);
    expect((await call(createBookingRoute, { token: tech.ctx.token, body: { customerId: mine.customer.id, vehicleId: mine.vehicle.id, serviceLabel: 'x', date: nextWeekday(4), time: '09:00' } })).status).toBe(403);
    expect((await call(assignRoute, { token: tech.ctx.token, params: { id: job.id }, body: { primaryTechnicianMembershipId: tech.ctx.membership.id } })).status).toBe(403);
    expect((await call(statusRoute, { token: tech.ctx.token, params: { id: job.id }, body: { status: 'INSPECTION' } })).status).toBe(403); // not assigned to them
    expect((await call(assignRoute, { token: A.ctx.token, params: { id: job.id }, body: { primaryTechnicianMembershipId: tech.ctx.membership.id } })).status).toBe(200);
    expect((await call(statusRoute, { token: tech.ctx.token, params: { id: job.id }, body: { status: 'INSPECTION' } })).status).toBe(200);
    expect((await call(myJobsRoute, { token: tech.ctx.token })).body.data.map((j: { id: string }) => j.id)).toContain(job.id);
    expect((await call(createVehicleRoute, { token: tech.ctx.token, body: { customerId: mine.customer.id, registration: 'TECH 1 GP' } })).status).toBe(403);
    const card = await call(jobRoute, { token: tech.ctx.token, params: { id: job.id } });
    expect(card.status).toBe(200);
    expect(card.body.data.total).toBeNull(); // no pricing for technicians
    expect((await call(reportRoute, { token: tech.ctx.token, params: { id: job.id } })).status).toBe(404); // no inspection yet
  });

  it('validation errors come back as field-level 422 envelopes; page sizes are capped', async () => {
    const r = await call(createVehicleRoute, { token: A.ctx.token, body: { customerId: 'not-a-uuid', year: 'abc' } });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    expect((await call(jobsRoute, { token: A.ctx.token, query: { pageSize: 1000 } })).status).toBe(422);
    expect((await call(vehiclesRoute, { token: A.ctx.token, query: { page: 0 } })).status).toBe(422);
    expect((await call(calendarRoute, { token: A.ctx.token, query: { view: 'week', date: 'tomorrow' } })).status).toBe(422);
  });

  it('a read-only (expired) subscription still lets people look, but blocks every change', async () => {
    const w = await createWorkspace('Expired Workshop');
    const mine = await seedCustomerVehicle(w, 'Exp');
    const { job } = await createJob(w.ctx, { customerId: mine.customer.id, vehicleId: mine.vehicle.id });
    await ownerQuery("UPDATE subscriptions SET status = 'EXPIRED', trial_ends_at = now() - interval '30 days' WHERE business_id = $1", [w.businessId]);
    const { businessContext } = await import('../helpers/factory');
    const ctx = await businessContext(w.owner);
    expect((await call(jobRoute, { token: ctx.token, params: { id: job.id } })).status).toBe(200);
    expect((await call(vehiclesRoute, { token: ctx.token })).status).toBe(200);
    expect((await call(statusRoute, { token: ctx.token, params: { id: job.id }, body: { status: 'INSPECTION' } })).status).toBe(402);
    expect((await call(createJobRoute, { token: ctx.token, body: { customerId: mine.customer.id, vehicleId: mine.vehicle.id } })).status).toBe(402);
    expect((await call(createBookingRoute, { token: ctx.token, body: {} })).status).toBe(402);
  });
});
