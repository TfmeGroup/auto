import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { createCustomer, getCustomerOverview, listCustomers, setCustomerArchived, setCustomerStatus, updateCustomer } from '@/server/customers/service';
import {
  addVehicleContact, correctMileage, createVehicle, getVehicle, listMileage, listVehicles, recordMileage, setVehicleArchived, setVehicleStatus, updateVehicle,
} from '@/server/vehicles/service';
import { addInterval, listIntervals, markIntervalServiced } from '@/server/vehicles/insights';
import { listTimeline } from '@/server/activity/service';
import { updateBusiness } from '@/server/businesses/service';
import { createJob } from '@/server/jobcards/service';
import { customerInput } from '../helpers/customers';
import { appClient, createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { memberWithPermissions, seedCustomerVehicle } from '../helpers/workshop';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await createWorkspace('Customers And Vehicles Workshop');
});

describe('customers', () => {
  it('creates a customer with a unique number in the right business', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Thandi Nkosi', { email: 'thandi@example.test', phone: '082 555 0101' }));
    expect(c.customerNumber).toMatch(/^CUS-\d{6}$/);
    expect(c).toMatchObject({ businessId: ws.businessId, name: 'Thandi Nkosi', firstName: 'Thandi', lastName: 'Nkosi', status: 'ACTIVE', type: 'INDIVIDUAL', mobile: '082 555 0101' });
    const d = await createCustomer(ws.ctx, customerInput('Second Person'));
    expect(Number(d.customerNumber.slice(4))).toBe(Number(c.customerNumber.slice(4)) + 1);
  });

  it('asks only for what a normal customer needs, and requires the company name for business customers', async () => {
    const minimal = await createCustomer(ws.ctx, { firstName: 'Min', lastName: 'Imal', mobile: '0821112222' });
    expect(minimal.email).toBeNull();
    await expect(createCustomer(ws.ctx, { firstName: 'No', lastName: 'Mobile' })).rejects.toMatchObject({ status: 422 });
    await expect(createCustomer(ws.ctx, { firstName: '', lastName: 'x', mobile: '0821112222' })).rejects.toMatchObject({ status: 422 });
    await expect(createCustomer(ws.ctx, { firstName: 'Fleet', lastName: 'Boss', mobile: '0821112222', type: 'BUSINESS' })).rejects.toMatchObject({ status: 422, details: { companyName: expect.any(String) } });
    const biz = await createCustomer(ws.ctx, { firstName: 'Fleet', lastName: 'Boss', mobile: '0821112222', type: 'BUSINESS', companyName: 'Acme Haulage', companyRegNumber: '2010/123456/07', preferredContact: 'WHATSAPP', marketingConsent: true });
    expect(biz).toMatchObject({ type: 'BUSINESS', companyName: 'Acme Haulage', preferredContact: 'WHATSAPP', marketingConsent: true });
    expect(biz.marketingConsentAt).toBeInstanceOf(Date);
  });

  it('searches by first name, last name, full name, number, mobile, email and company (server side)', async () => {
    const c = await createCustomer(ws.ctx, { firstName: 'Zinhle', lastName: 'Quartermain', mobile: '083 777 4455', email: 'zinhle.q@example.test', type: 'BUSINESS', companyName: 'Quartz Panelbeaters' });
    const find = async (q: string) => (await listCustomers(ws.ctx, { q })).items.map((i) => i!.id);
    for (const q of ['Zinhle', 'quarter', 'Zinhle Quartermain', 'Quartermain Zinhle', c.customerNumber, c.customerNumber.toLowerCase(), '0837774455', '777 44', 'zinhle.q@', 'Quartz Panel']) {
      expect(await find(q), q).toContain(c.id);
    }
    expect(await find('Zinhle Nobody')).toEqual([]);
    expect(await find('%')).toEqual([]); // wildcard characters are matched literally
  });

  it('paginates and filters by status, type and sort order', async () => {
    const w = await createWorkspace('Paging Workshop');
    for (let i = 0; i < 7; i++) await createCustomer(w.ctx, customerInput(`Page Person${String(i).padStart(2, '0')}`));
    const biz = await createCustomer(w.ctx, { firstName: 'B', lastName: 'Corp', mobile: '0821112222', type: 'BUSINESS', companyName: 'B Corp' });
    const p1 = await listCustomers(w.ctx, { pageSize: 3, page: 1, sort: 'name', dir: 'asc' });
    const p3 = await listCustomers(w.ctx, { pageSize: 3, page: 3, sort: 'name', dir: 'asc' });
    expect(p1.meta).toMatchObject({ total: 8, totalPages: 3, page: 1 });
    expect(p1.items).toHaveLength(3);
    expect(p3.items).toHaveLength(2);
    const names = [...p1.items, ...(await listCustomers(w.ctx, { pageSize: 3, page: 2, sort: 'name', dir: 'asc' })).items, ...p3.items].map((i) => i!.name);
    expect(new Set(names).size).toBe(8);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect((await listCustomers(w.ctx, { type: 'BUSINESS' })).items.map((i) => i!.id)).toEqual([biz.id]);
    expect((await listCustomers(w.ctx, { q: 'Person0', pageSize: 2 })).meta.total).toBe(7);
    await setCustomerStatus(w.ctx, biz.id, 'INACTIVE');
    expect((await listCustomers(w.ctx, { status: 'INACTIVE' })).items.map((i) => i!.id)).toEqual([biz.id]);
    expect((await listCustomers(w.ctx, { status: 'ACTIVE' })).meta.total).toBe(7);
    await expect(listCustomers(w.ctx, { pageSize: 500 })).rejects.toMatchObject({ status: 422 });
  });

  it('edits safely, keeps the display name in step, and records a timeline event', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Edit');
    const after = await updateCustomer(ws.ctx, customer.id, { firstName: 'Renamed' });
    expect(after.name).toBe(`Renamed ${customer.lastName}`);
    const tl = await listTimeline(ws.ctx, { customerId: customer.id }, {});
    expect(tl.items.map((e) => e.type)).toEqual(expect.arrayContaining(['customer.created', 'customer.updated', 'vehicle.added']));
  });

  it('a partial edit never resets fields it did not mention (type, marketing consent, VAT registration)', async () => {
    const c = await createCustomer(ws.ctx, { firstName: 'Keep', lastName: 'Fields', mobile: '0821112222', type: 'BUSINESS', companyName: 'Keep Co', marketingConsent: true });
    const after = await updateCustomer(ws.ctx, c.id, { notes: 'just a note' });
    expect(after).toMatchObject({ type: 'BUSINESS', marketingConsent: true, companyName: 'Keep Co' });
    expect(after.marketingConsentAt).toBeInstanceOf(Date);
    const w = await createWorkspace('Vat Workshop');
    await updateBusiness(w.ctx, { vatRegistered: true, vatNumber: '4123456789' });
    const b = await updateBusiness(w.ctx, { phone: '021 555 0199' });
    expect(b).toMatchObject({ vatRegistered: true, vatNumber: '4123456789', phone: '021 555 0199' });
  });

  it('two people editing the same customer at once are applied one after the other, never interleaved', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Race Customer'));
    const [a, b] = await Promise.all([updateCustomer(ws.ctx, c.id, { firstName: 'Alpha' }), updateCustomer(ws.ctx, c.id, { lastName: 'Bravo' })]);
    expect(a.id).toBe(b.id);
    const final = (await ownerQuery('SELECT name, first_name, last_name FROM customers WHERE id = $1', [c.id])).rows[0]!;
    expect(final).toMatchObject({ first_name: 'Alpha', last_name: 'Bravo', name: 'Alpha Bravo' }); // both edits kept; the display name matches both
  });

  it('archiving keeps history, is blocked by an open job, and archived customers cannot be edited', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Arch');
    const { job } = await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Noise' });
    await expect(setCustomerArchived(ws.ctx, customer.id, true)).rejects.toMatchObject({ status: 409 });
    await ownerQuery("UPDATE job_cards SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [job.id]);
    const archived = await setCustomerArchived(ws.ctx, customer.id, true);
    expect(archived).toMatchObject({ status: 'ARCHIVED' });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    const kept = await ownerQuery('SELECT customer_id FROM job_cards WHERE id = $1', [job.id]);
    expect(kept.rows[0]!.customer_id).toBe(customer.id); // history still points at them
    await expect(updateCustomer(ws.ctx, customer.id, { firstName: 'X' })).rejects.toMatchObject({ status: 409 });
    expect((await listCustomers(ws.ctx, { q: customer.customerNumber })).items).toHaveLength(0);
    expect((await listCustomers(ws.ctx, { q: customer.customerNumber, status: 'ARCHIVED' })).items).toHaveLength(1);
    await setCustomerArchived(ws.ctx, customer.id, false);
    expect((await updateCustomer(ws.ctx, customer.id, { notes: 'back' })).notes).toBe('back');
  });

  it('the overview is built from live data and says financials are not available yet', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Over');
    await createVehicle(ws.ctx, { customerId: customer.id, registration: 'OVR 002 GP', make: 'Ford', model: 'Ranger' });
    await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id });
    const o = await getCustomerOverview(ws.ctx, customer.id);
    expect(o).toMatchObject({ vehicleCount: 2, totalJobs: 1, activeJobs: 1, financial: { available: false } });
    expect(o.latestActivity).not.toBeNull();
  });
});

describe('vehicles', () => {
  it('creates vehicles with practical required fields and a customer owner', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Owner One'));
    const v = await createVehicle(ws.ctx, { customerId: c.id, registration: 'ca 123-456', make: 'BMW', model: '320i', year: '2018', mileageKm: '81000', fuelType: 'PETROL', transmission: 'AUTOMATIC', vin: 'wba8e91080k123456' });
    expect(v).toMatchObject({ registration: 'CA 123-456', registrationNorm: 'CA123456', vin: 'WBA8E91080K123456', year: 2018, mileageKm: 81000, status: 'ACTIVE', businessId: ws.businessId, customerId: c.id });
    await expect(createVehicle(ws.ctx, { customerId: c.id })).rejects.toMatchObject({ status: 422 }); // nothing identifying
    expect((await createVehicle(ws.ctx, { customerId: c.id, make: 'Ford', model: 'Fiesta' })).registration).toBeNull(); // make + model is enough
    await expect(createVehicle(ws.ctx, { customerId: c.id, vin: 'SHORT' })).rejects.toMatchObject({ status: 422 });
    await expect(createVehicle(ws.ctx, { customerId: c.id, registration: 'X1 GP', year: 1800 })).rejects.toMatchObject({ status: 422 });
    await expect(createVehicle(ws.ctx, { customerId: '00000000-0000-4000-8000-000000000000', registration: 'NOPE 1 GP' })).rejects.toMatchObject({ status: 422 });
  });

  it('a customer can own several vehicles; vehicle and customer stay separate records', async () => {
    const c = await createCustomer(ws.ctx, customerInput('John Smith'));
    const makes: [string, string][] = [['BMW', '320i'], ['Toyota', 'Hilux'], ['Ford', 'Ranger']];
    for (const [i, [make, model]] of makes.entries()) await createVehicle(ws.ctx, { customerId: c.id, registration: `JS${i} 00${i} GP`, make, model });
    const list = await listVehicles(ws.ctx, { customerId: c.id });
    expect(list.meta.total).toBe(3);
    expect(list.items.map((v) => v!.model).sort()).toEqual(['320i', 'Hilux', 'Ranger']);
    expect(list.items.every((v) => v!.customer.id === c.id)).toBe(true);
  });

  it('searches by registration (any spacing), VIN, make, model and owner', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Searchable Owner'));
    const v = await createVehicle(ws.ctx, { customerId: c.id, registration: 'GP 55 ZZ GP', vin: 'AHTFR22G600123456', make: 'Toyota', model: 'Fortuner' });
    const find = async (q: string) => (await listVehicles(ws.ctx, { q })).items.map((i) => i!.id);
    for (const q of ['GP55ZZGP', 'gp 55', '55-zz', 'AHTFR22G600123456', '600123', 'Fortuner', 'toyota fortuner', 'Searchable', c.customerNumber]) expect(await find(q), q).toContain(v.id);
    expect(await find('Fortuner Mercedes')).toEqual([]);
    expect((await listVehicles(ws.ctx, { make: 'Toyota', model: 'Fortuner' })).items.map((i) => i!.id)).toContain(v.id);
  });

  it('keeps registration and VIN unique inside a business, but not across businesses', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Unique Owner'));
    const first = await createVehicle(ws.ctx, { customerId: c.id, registration: 'UNQ 1 GP', vin: 'JTDKB20U977123456' });
    await expect(createVehicle(ws.ctx, { customerId: c.id, registration: 'unq-1-gp' })).rejects.toMatchObject({ status: 422, details: { registration: expect.any(String) } });
    await expect(createVehicle(ws.ctx, { customerId: c.id, registration: 'OTHER 1 GP', vin: 'jtdkb20u977123456' })).rejects.toMatchObject({ status: 422, details: { vin: expect.any(String) } });
    // The database enforces it too (not only the application).
    await expect(ownerQuery("INSERT INTO vehicles (business_id, customer_id, registration, registration_norm, updated_at) VALUES ($1, $2, 'UNQ 1 GP', 'UNQ1GP', now())", [ws.businessId, c.id])).rejects.toThrow(/vehicles_registration_uniq/);

    const other = await createWorkspace('Other Business Same Plate');
    const oc = await createCustomer(other.ctx, customerInput('Their Customer'));
    const theirs = await createVehicle(other.ctx, { customerId: oc.id, registration: 'UNQ 1 GP', vin: 'JTDKB20U977123456' });
    expect(theirs.id).not.toBe(first.id); // same plate and VIN are fine in another business

    await setVehicleArchived(ws.ctx, first.id, true); // archived vehicles release their identifiers
    const again = await createVehicle(ws.ctx, { customerId: c.id, registration: 'UNQ 1 GP' });
    await expect(setVehicleArchived(ws.ctx, first.id, false)).rejects.toMatchObject({ status: 422 });
    await setVehicleArchived(ws.ctx, again.id, true);
    expect((await setVehicleArchived(ws.ctx, first.id, false)).archivedAt).toBeNull();
  });

  it('moving a vehicle to another owner is audited and appears on both timelines', async () => {
    const a = await createCustomer(ws.ctx, customerInput('Old Owner'));
    const b = await createCustomer(ws.ctx, customerInput('New Owner'));
    const v = await createVehicle(ws.ctx, { customerId: a.id, registration: 'MOVE 1 GP' });
    await updateVehicle(ws.ctx, v.id, { customerId: b.id });
    expect((await getVehicle(ws.ctx, v.id)).customer.id).toBe(b.id);
    expect((await listTimeline(ws.ctx, { customerId: a.id }, {})).items.some((e) => e.type === 'vehicle.owner_changed')).toBe(true);
    expect((await listTimeline(ws.ctx, { customerId: b.id }, {})).items.some((e) => e.type === 'vehicle.owner_changed')).toBe(true);
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE resource_id = $1 AND action = 'vehicle.updated' ORDER BY created_at DESC LIMIT 1", [v.id]);
    expect(audit.rows[0]!.metadata).toMatchObject({ ownerChangedFrom: a.id, ownerChangedTo: b.id });
  });

  it('records authorised contacts', async () => {
    const { vehicle } = await seedCustomerVehicle(ws, 'Contacts');
    await addVehicleContact(ws.ctx, vehicle.id, { name: 'Spouse', mobile: '0829998888', relationship: 'Wife' });
    expect((await getVehicle(ws.ctx, vehicle.id)).contacts).toHaveLength(1);
  });
});

describe('mileage history', () => {
  it('records readings in order, refuses a lower reading, and keeps every row', async () => {
    const { vehicle } = await seedCustomerVehicle(ws, 'Mile');
    await recordMileage(ws.ctx, vehicle.id, { mileageKm: 52_000, note: 'Customer reported' });
    await recordMileage(ws.ctx, vehicle.id, { mileageKm: 52_000 }); // same reading is fine
    await expect(recordMileage(ws.ctx, vehicle.id, { mileageKm: 40_000 })).rejects.toMatchObject({ status: 422, details: { mileageKm: expect.stringContaining('52') } });
    expect((await getVehicle(ws.ctx, vehicle.id)).mileageKm).toBe(52_000);
    const hist = await listMileage(ws.ctx, vehicle.id, {});
    expect(hist.items.map((h) => [h.mileageKm, h.source])).toEqual([[52_000, 'MANUAL'], [52_000, 'MANUAL'], [50_000, 'CREATED']]);
    expect(hist.items[0]!.recordedBy).toBeTruthy();
  });

  it('a correction needs the permission and a reason, and is added as history rather than editing it', async () => {
    const { vehicle } = await seedCustomerVehicle(ws, 'Corr');
    const tech = await createMemberCtx(ws, 'technician');
    await expect(correctMileage(tech.ctx, vehicle.id, { mileageKm: 45_000, reason: 'typo' })).rejects.toMatchObject({ status: 403 });
    await expect(correctMileage(ws.ctx, vehicle.id, { mileageKm: 45_000 })).rejects.toMatchObject({ status: 422 });
    const v = await correctMileage(ws.ctx, vehicle.id, { mileageKm: 45_000, reason: 'Odometer misread at check-in' });
    expect(v.mileageKm).toBe(45_000);
    const hist = await listMileage(ws.ctx, vehicle.id, {});
    expect(hist.items[0]).toMatchObject({ source: 'CORRECTION', isCorrection: true, mileageKm: 45_000, note: 'Odometer misread at check-in' });
    expect(hist.items.some((h) => h.mileageKm === 50_000)).toBe(true); // the original reading is still there
  });

  it('the database refuses to edit or delete mileage history', async () => {
    const { vehicle } = await seedCustomerVehicle(ws, 'Append');
    const db = await appClient();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.business_id', $1, true)", [ws.businessId]);
      await expect(db.query('UPDATE vehicle_mileage_log SET mileage_km = 1 WHERE vehicle_id = $1', [vehicle.id])).rejects.toThrow(/append-only/);
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.business_id', $1, true)", [ws.businessId]);
      await expect(db.query('DELETE FROM vehicle_mileage_log WHERE vehicle_id = $1', [vehicle.id])).rejects.toThrow(/append-only/);
    } finally {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    }
  });
});

describe('vehicle status and service intervals', () => {
  it('status is manual unless a job rule changes it, and every change records why', async () => {
    const { vehicle } = await seedCustomerVehicle(ws, 'Stat');
    const v = await setVehicleStatus(ws.ctx, vehicle.id, { status: 'AWAITING_SERVICE', reason: 'Customer called' });
    expect(v.status).toBe('AWAITING_SERVICE');
    const tl = await listTimeline(ws.ctx, { vehicleId: vehicle.id }, {});
    expect(tl.items.find((e) => e.type === 'vehicle.status_changed')!.summary).toContain('Customer called');
    await expect(setVehicleStatus(ws.ctx, vehicle.id, { status: 'FLYING' })).rejects.toMatchObject({ status: 422 });
  });

  it('keeps maintenance intervals by distance, time or both, and resets them when serviced', async () => {
    const { vehicle } = await seedCustomerVehicle(ws, 'Int');
    await expect(addInterval(ws.ctx, vehicle.id, { name: 'Empty' })).rejects.toMatchObject({ status: 422 });
    const i = await addInterval(ws.ctx, vehicle.id, { name: 'Oil service', everyKm: 10_000, everyMonths: 12, lastServiceKm: 38_000, lastServiceAt: '2024-01-01' });
    let [row] = await listIntervals(ws.ctx, vehicle.id);
    expect(row!.status).toMatchObject({ overdueByKm: true, overdueByDate: true, nextDueKm: 48_000 }); // vehicle is at 50 000 km
    await expect(markIntervalServiced(ws.ctx, vehicle.id, i.id, { km: 40_000 })).rejects.toMatchObject({ status: 422 }); // a service reading cannot go backwards either
    await markIntervalServiced(ws.ctx, vehicle.id, i.id, { km: 50_000 });
    [row] = await listIntervals(ws.ctx, vehicle.id);
    expect(row!.status).toMatchObject({ overdue: false, nextDueKm: 60_000 });
    const { vehicle: v2 } = await seedCustomerVehicle(ws, 'Svc2');
    const i2 = await addInterval(ws.ctx, v2.id, { name: 'Brake check', everyMonths: 6 });
    await markIntervalServiced(ws.ctx, v2.id, i2.id, { km: 50_800 });
    expect((await listMileage(ws.ctx, v2.id, {})).items[0]).toMatchObject({ mileageKm: 50_800, source: 'SERVICE' });
  });
});

describe('permissions on customers and vehicles', () => {
  it('a technician can view and edit vehicles but cannot create customers or archive anything', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Perm');
    await expect(createCustomer(tech.ctx, customerInput('Nope'))).rejects.toMatchObject({ status: 403 });
    await expect(createVehicle(tech.ctx, { customerId: customer.id, registration: 'NOPE 9 GP' })).rejects.toMatchObject({ status: 403 });
    await expect(setVehicleArchived(tech.ctx, vehicle.id, true)).rejects.toMatchObject({ status: 403 });
    expect((await updateVehicle(tech.ctx, vehicle.id, { colour: 'Blue' })).colour).toBe('Blue');
  });

  it('filters that reveal jobs or bookings need permission to see them', async () => {
    const onlyCustomers = await memberWithPermissions(ws, ['customer.view']);
    await expect(listCustomers(onlyCustomers.ctx, { hasActiveJob: 'true' })).rejects.toMatchObject({ status: 403 });
    await expect(listCustomers(onlyCustomers.ctx, { hasUpcomingBooking: 'true' })).rejects.toMatchObject({ status: 403 });
    expect((await listCustomers(onlyCustomers.ctx, {})).meta.total).toBeGreaterThan(0);
  });

  it('timelines only show the areas the viewer may see', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Tl');
    await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id });
    const full = await listTimeline(ws.ctx, { customerId: customer.id }, {});
    expect(full.items.some((e) => e.type.startsWith('job.'))).toBe(true);
    const limited = await memberWithPermissions(ws, ['customer.view']);
    const some = await listTimeline(limited.ctx, { customerId: customer.id }, {});
    expect(some.items.length).toBeGreaterThan(0);
    expect(some.items.every((e) => e.type.startsWith('customer.'))).toBe(true);
    await expect(listTimeline(limited.ctx, { vehicleId: vehicle.id }, {})).rejects.toMatchObject({ status: 403 });
  });
});
