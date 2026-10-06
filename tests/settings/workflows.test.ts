import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { resolveBusinessContext, authenticate } from '@/server/tenancy/context';
import { createCustomer } from '@/server/customers/service';
import { createInvoice, finaliseInvoice } from '@/server/finance/invoices';
import { changeJobStatus, createJob } from '@/server/jobcards/service';
import { createPart } from '@/server/inventory/parts';
import { inviteMember } from '@/server/memberships/service';
import { createVehicle, updateVehicle } from '@/server/vehicles/service';
import { addInterval } from '@/server/vehicles/insights';
import { createManualEntry, postTimeToLabour } from '@/server/team/time';
import { addWaitingEntry } from '@/server/bookings/extras';
import { cancelBooking, createBooking } from '@/server/bookings/service';
import { listServiceTypes, updateRules } from '@/server/workshop/service';
import { listLocations, renameLocation } from '@/server/locations/service';
import { getInvoicePdf } from '@/server/finance/pdfs';
import {
  getNumbering, getRetention, getJobConfig, updateInventoryDefaults, updateJobConfig, updateLabourRules, updateNumbering, updateReportingSettings, updateRetention, updateSecuritySettings, updateVehicleConfig, billedMinutes,
} from '@/server/settings/config-service';
import { createJobFromTemplate, listJobTemplates, listServiceCatalogue, saveJobTemplate, saveService, serviceLine } from '@/server/settings/catalogue';
import { customerInput } from '../helpers/customers';
import { createMemberCtx, createWorkspace, ownerQuery, upgradePlan, businessContext, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, pdfText } from '../helpers/finance';
import { mkPart, openJob } from '../helpers/inventory';
import { memberWithPermissions, nextWeekday, seedCustomerVehicle } from '../helpers/workshop';

afterAll(disconnectPrisma);

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};
const auditOf = (ws: TestWorkspace, action: string) => ownerQuery<{ before: unknown; after: unknown; metadata: unknown }>('SELECT before, after, metadata FROM audit_logs WHERE business_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1', [ws.businessId, action]);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await financeWorkspace('Settings Workshop');
  await upgradePlan(ws, 'business');
});

describe('numbering', () => {
  it('a changed prefix applies to new numbers only, the counter keeps going, and an old number is never reused', async () => {
    const a = await createCustomer(ws.ctx, customerInput('First Cust'));
    expect(a.customerNumber).toBe('CUS-000001');
    await updateNumbering(ws.ctx, { customerPrefix: 'cli', customerPadding: 4 });
    const b = await createCustomer(ws.ctx, customerInput('Second Cust'));
    expect(b.customerNumber).toBe('CLI-0002');
    expect((await ownerQuery<{ n: string }>('SELECT customer_number AS n FROM customers WHERE id = $1', [a.id])).rows[0]!.n).toBe('CUS-000001'); // the old one is untouched
    await updateNumbering(ws.ctx, { customerPrefix: 'CUS', customerPadding: 6 }); // back to the old prefix
    const c = await createCustomer(ws.ctx, customerInput('Third Cust'));
    expect(c.customerNumber).toBe('CUS-000003'); // not CUS-000002 / CUS-000001 again
    const audit = await auditOf(ws, 'config.numbering_changed');
    expect(JSON.stringify(audit.rows[0]!.before)).toContain('CLI');
  });

  it('finance and inventory prefixes are changed here too, and apply to the next document', async () => {
    await updateNumbering(ws.ctx, { invoicePrefix: 'TAX', poPrefix: 'ORD' });
    const p = await seedCustomerVehicle(ws, 'Num');
    const d = await createInvoice(ws.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, lines: [L('Part', 1, 10_000)] });
    const fin = await finaliseInvoice(ws.ctx, d.id);
    expect(fin.number).toMatch(/^TAX-\d{6}$/);
    const n = await getNumbering(ws.ctx);
    expect(n.kinds.find((k) => k.id === 'invoice')).toMatchObject({ prefix: 'TAX', issued: 1 });
    expect(n.kinds.find((k) => k.id === 'purchase_order')!.prefix).toBe('ORD');
    await updateNumbering(ws.ctx, { invoicePrefix: 'INV', poPrefix: 'PO' });
  });

  it('two kinds of record can never share a prefix, and prefixes must be plain letters and digits', async () => {
    expect((await err(updateNumbering(ws.ctx, { customerPrefix: 'JOB' }))).status).toBe(422);
    expect((await err(updateNumbering(ws.ctx, { invoicePrefix: 'QUO' }))).status).toBe(422);
    expect((await err(updateNumbering(ws.ctx, { customerPrefix: 'A B' }))).status).toBe(422);
    expect((await err(updateNumbering(ws.ctx, { customerPrefix: 'TOOLONGPREFIX' }))).status).toBe(422);
    expect((await err(updateNumbering(ws.ctx, { customerPadding: 2 }))).status).toBe(422);
  });

  it('each group of prefixes needs its own permission', async () => {
    const wk = await memberWithPermissions(ws, ['settings.view', 'settings.manage_workshop']);
    await updateNumbering(wk.ctx, { bookingPrefix: 'APT' });
    expect((await err(updateNumbering(wk.ctx, { invoicePrefix: 'ZZZ' }))).status).toBe(403);
    expect((await err(updateNumbering(wk.ctx, { poPrefix: 'ZZZ' }))).status).toBe(403);
    const none = await memberWithPermissions(ws, ['settings.view']);
    expect((await err(updateNumbering(none.ctx, { jobPrefix: 'XX' }))).status).toBe(403);
    await updateNumbering(ws.ctx, { bookingPrefix: 'BKG' });
  });
});

describe('labour rounding and minimum billable time', () => {
  it('billedMinutes: rounds up or to the nearest step, then applies the minimum', () => {
    expect(billedMinutes(47, { minBillableMinutes: 0, timeRoundingMinutes: 0, timeRoundingMode: 'UP' })).toBe(47);
    expect(billedMinutes(47, { minBillableMinutes: 0, timeRoundingMinutes: 15, timeRoundingMode: 'UP' })).toBe(60);
    expect(billedMinutes(40, { minBillableMinutes: 0, timeRoundingMinutes: 15, timeRoundingMode: 'NEAREST' })).toBe(45);
    expect(billedMinutes(37, { minBillableMinutes: 0, timeRoundingMinutes: 15, timeRoundingMode: 'NEAREST' })).toBe(30);
    expect(billedMinutes(5, { minBillableMinutes: 30, timeRoundingMinutes: 0, timeRoundingMode: 'UP' })).toBe(30);
    expect(billedMinutes(5, { minBillableMinutes: 0, timeRoundingMinutes: 15, timeRoundingMode: 'NEAREST' })).toBe(15); // never rounds down to nothing
  });

  it('time that becomes labour is billed by the rules, while the time entry keeps the actual minutes', async () => {
    const { job } = await openJob(ws);
    await ownerQuery("UPDATE job_cards SET opened_at = now() - interval '8 hours' WHERE id = $1", [job.id]);
    const start = new Date(Date.now() - 50 * 60_000);
    const before = await createManualEntry(ws.ctx, { jobId: job.id, startedAt: start, durationMinutes: 47 });
    await postTimeToLabour(ws.ctx, before.id);
    const lines = async () => (await ownerQuery<{ minutes: number; description: string }>('SELECT minutes, description FROM job_labour WHERE job_id = $1 ORDER BY created_at, id', [job.id])).rows;
    expect((await lines()).map((l) => l.minutes)).toEqual([47]); // no rule yet: exact
    await updateLabourRules(ws.ctx, { timeRoundingMinutes: 15, timeRoundingMode: 'UP', minBillableMinutes: 30 });
    const second = await createManualEntry(ws.ctx, { jobId: job.id, startedAt: new Date(Date.now() - 200 * 60_000), durationMinutes: 47 });
    await postTimeToLabour(ws.ctx, second.id);
    const all = await lines();
    expect(all.map((l) => l.minutes)).toEqual([47, 60]); // the line already on the job is not rewritten when the rule changes
    expect(all[1]!.description).toMatch(/worked 47 min, billed 60 min/);
    const entry = (await ownerQuery<{ duration_minutes: number }>('SELECT duration_minutes FROM time_entries WHERE id = $1', [second.id])).rows[0]!;
    expect(entry.duration_minutes).toBe(47); // the actual time is kept
    await updateLabourRules(ws.ctx, { timeRoundingMinutes: 0, minBillableMinutes: 0 });
  });

  it('needs the permission and the plan, and rejects nonsense', async () => {
    expect((await err(updateLabourRules(ws.ctx, { timeRoundingMinutes: 7 }))).status).toBe(422);
    expect((await err(updateLabourRules(ws.ctx, { minBillableMinutes: 9999 }))).status).toBe(422);
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(updateLabourRules(tech.ctx, { minBillableMinutes: 15 }))).status).toBe(403);
    const solo = await createWorkspace('Labour Solo');
    await ownerQuery("UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, plan_id = (SELECT id FROM plans WHERE key = 'solo'), current_period_start = now(), current_period_end = now() + interval '30 days' WHERE business_id = $1", [solo.businessId]);
    solo.ctx = await businessContext(solo.owner);
    expect((await err(updateLabourRules(solo.ctx, { minBillableMinutes: 15 }))).status).toBe(402);
  });
});

describe('job configuration', () => {
  it('required fields are enforced when a job is opened', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Req');
    await updateJobConfig(ws.ctx, { requiredFields: ['complaint', 'mileageKm'] });
    const e1 = await err(createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, arrived: true, isWalkIn: true }));
    expect(e1.status).toBe(422);
    expect(JSON.stringify(e1.details)).toMatch(/complaint/);
    expect(JSON.stringify(e1.details)).toMatch(/mileageKm/);
    const ok = await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, arrived: true, isWalkIn: true, complaint: 'Rattle', mileageKm: 51_000 });
    expect(ok.created).toBe(true);
    await updateJobConfig(ws.ctx, { requiredFields: [] });
    expect((await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, arrived: true, isWalkIn: true })).created).toBe(true);
  });

  it('a retired status cannot be chosen again, but a job already in it can leave it', async () => {
    const { job } = await openJob(ws);
    await ownerQuery("UPDATE job_cards SET status = 'IN_PROGRESS' WHERE id = $1", [job.id]);
    await updateJobConfig(ws.ctx, { retiredStatuses: ['AWAITING_PARTS'] });
    const e = await err(changeJobStatus(ws.ctx, job.id, { status: 'AWAITING_PARTS' }));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/switched off/);
    // a job that is already waiting for parts can still move on
    const other = await openJob(ws);
    await ownerQuery("UPDATE job_cards SET status = 'AWAITING_PARTS' WHERE id = $1", [other.job.id]);
    expect((await changeJobStatus(ws.ctx, other.job.id, { status: 'IN_PROGRESS' })).status).toBe('IN_PROGRESS');
    await updateJobConfig(ws.ctx, { retiredStatuses: [] });
    expect((await changeJobStatus(ws.ctx, job.id, { status: 'AWAITING_PARTS' })).status).toBe('AWAITING_PARTS');
  });

  it('only optional steps can be retired, and renamed statuses must stay distinct', async () => {
    expect((await err(updateJobConfig(ws.ctx, { retiredStatuses: ['COMPLETED'] }))).status).toBe(422);
    expect((await err(updateJobConfig(ws.ctx, { statusLabels: { IN_PROGRESS: 'Completed' } }))).status).toBe(422);
    expect((await err(updateJobConfig(ws.ctx, { statusLabels: { IN_PROGRESS: '<b>x</b>' } }))).status).toBe(422);
    await updateJobConfig(ws.ctx, { statusLabels: { IN_PROGRESS: 'On the ramp', READY_FOR_COLLECTION: 'Ready to go' }, priorityLabels: { URGENT: 'Rush' } });
    const c = await getJobConfig(ws.ctx);
    expect(c.status.IN_PROGRESS).toBe('On the ramp');
    expect(c.status.CHECKED_IN).toBe('Checked in'); // unchanged ones keep the standard wording
    expect(c.priority.URGENT).toBe('Rush');
    // only the differences are stored
    const row = (await ownerQuery<{ job_status_labels: Record<string, string> }>('SELECT job_status_labels FROM business_config WHERE business_id = $1', [ws.businessId])).rows[0]!;
    expect(Object.keys(row.job_status_labels).sort()).toEqual(['IN_PROGRESS', 'READY_FOR_COLLECTION']);
    await updateJobConfig(ws.ctx, { statusLabels: { IN_PROGRESS: 'In progress', READY_FOR_COLLECTION: 'Ready for collection' }, priorityLabels: { URGENT: 'Urgent' } });
  });
});

describe('vehicle configuration', () => {
  it('required fields and the allowed option lists apply to new vehicles; retired options stay valid on existing ones', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Veh Owner'));
    const existing = await createVehicle(ws.ctx, { customerId: c.id, registration: 'CA 100 100', make: 'Toyota', model: 'Hilux', fuelType: 'DIESEL', transmission: 'MANUAL' });
    await updateVehicleConfig(ws.ctx, { requiredFields: ['vin', 'year'], mileageRequired: true, enabledFuelTypes: ['PETROL'], enabledTransmissions: ['AUTOMATIC'] });
    const e = await err(createVehicle(ws.ctx, { customerId: c.id, registration: 'CA 200 200', make: 'VW', model: 'Polo', fuelType: 'DIESEL' }));
    const d = JSON.stringify(e.details);
    expect(d).toMatch(/vin/);
    expect(d).toMatch(/year/);
    expect(d).toMatch(/mileageKm/);
    expect(d).toMatch(/fuelType/);
    const made = await createVehicle(ws.ctx, { customerId: c.id, registration: 'CA 200 200', vin: '1HGCM82633A004352', year: 2020, mileageKm: 1000, fuelType: 'PETROL', make: 'VW', model: 'Polo' });
    expect(made.registration).toBe('CA 200 200');
    // the old vehicle keeps its retired values and can still be edited
    const edited = await updateVehicle(ws.ctx, existing.id, { colour: 'White' });
    expect(edited.fuelType).toBe('DIESEL');
    expect(edited.colour).toBe('White');
    // but you cannot newly choose a retired option
    expect((await err(updateVehicle(ws.ctx, made.id, { transmission: 'MANUAL' }))).status).toBe(422);
    await updateVehicleConfig(ws.ctx, { requiredFields: [], mileageRequired: false, enabledFuelTypes: [], enabledTransmissions: [] });
  });

  it('the default service interval is used when none is typed', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Interval Owner'));
    const v = await createVehicle(ws.ctx, { customerId: c.id, registration: 'CA 300 300', make: 'Kia', model: 'Rio' });
    expect((await err(addInterval(ws.ctx, v.id, { name: 'Service' }))).status).toBe(422); // no default yet
    await updateVehicleConfig(ws.ctx, { defaultIntervalKm: 15_000, defaultIntervalMonths: 12 });
    const i = await addInterval(ws.ctx, v.id, { name: 'Service' });
    expect(i).toMatchObject({ everyKm: 15_000, everyMonths: 12 });
    const typed = await addInterval(ws.ctx, v.id, { name: 'Oil', everyKm: 5000 });
    expect(typed).toMatchObject({ everyKm: 5000, everyMonths: null }); // what was typed wins
    await updateVehicleConfig(ws.ctx, { defaultIntervalKm: null, defaultIntervalMonths: null });
  });
});

describe('inventory defaults', () => {
  it('fill a blank reorder quantity and sell price on a new part, but never override what was typed', async () => {
    await updateInventoryDefaults(ws.ctx, { defaultReorderQuantity: 12, defaultMarkupPercent: 40 });
    const a = await createPart(ws.ctx, { sku: `DEF-A-${Date.now()}`, name: 'Defaulted', costCents: 10_000 });
    const rowA = (await ownerQuery<{ sell_price_cents: number; reorder_quantity: number }>('SELECT sell_price_cents, reorder_quantity FROM parts WHERE id = $1', [a.id])).rows[0]!;
    expect(rowA).toEqual({ sell_price_cents: 14_000, reorder_quantity: 12 });
    const b = await createPart(ws.ctx, { sku: `DEF-B-${Date.now()}`, name: 'Typed', costCents: 10_000, sellPriceCents: 99_999, reorderQuantity: 3 });
    const rowB = (await ownerQuery<{ sell_price_cents: number; reorder_quantity: number }>('SELECT sell_price_cents, reorder_quantity FROM parts WHERE id = $1', [b.id])).rows[0]!;
    expect(rowB).toEqual({ sell_price_cents: 99_999, reorder_quantity: 3 });
    // existing parts are not repriced when the markup changes
    await updateInventoryDefaults(ws.ctx, { defaultMarkupPercent: 80 });
    expect((await ownerQuery<{ s: number }>('SELECT sell_price_cents AS s FROM parts WHERE id = $1', [a.id])).rows[0]!.s).toBe(14_000);
    expect((await err(updateInventoryDefaults(ws.ctx, { defaultMarkupPercent: -5 }))).status).toBe(422);
    await updateInventoryDefaults(ws.ctx, { defaultReorderQuantity: null, defaultMarkupPercent: null });
  });
});

describe('booking rules', () => {
  it('walk-ins and the waiting list can be switched off', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Rule');
    await updateRules(ws.ctx, { allowWalkIns: false, waitingListEnabled: false });
    expect((await err(createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, arrived: true, isWalkIn: true }))).message).toMatch(/Walk-ins are switched off/);
    expect((await err(addWaitingEntry(ws.ctx, { customerId: customer.id, serviceLabel: 'Anything' }))).message).toMatch(/waiting list is switched off/);
    await updateRules(ws.ctx, { allowWalkIns: true, waitingListEnabled: true });
    expect((await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, arrived: true, isWalkIn: true })).created).toBe(true);
  });

  it('a daily limit stops further bookings that day, and a buffer keeps technicians apart', async () => {
    const types = await listServiceTypes(ws.ctx);
    const service = types.find((t) => t.name === 'Diagnostic')!.id;
    const date = nextWeekday(3);
    const mk = async (time: string) => {
      const p = await seedCustomerVehicle(ws, 'Day');
      return createBooking(ws.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, serviceTypeId: service, date, time });
    };
    await updateRules(ws.ctx, { maxDailyBookings: 2 });
    await mk('08:00');
    await mk('10:00');
    expect((await err(mk('13:00'))).message).toMatch(/limited to 2 bookings a day/);
    await updateRules(ws.ctx, { maxDailyBookings: '' });
    await mk('13:00');
    const tech = (await createMemberCtx(ws, 'technician')).ctx.membership.id;
    await updateRules(ws.ctx, { bufferMinutes: 30 });
    const date2 = nextWeekday(4);
    const p = await seedCustomerVehicle(ws, 'Buf');
    await createBooking(ws.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, serviceTypeId: service, date: date2, time: '09:00', technicianMembershipId: tech }); // 09:00-10:00
    const p2 = await seedCustomerVehicle(ws, 'Buf2');
    expect((await err(createBooking(ws.ctx, { customerId: p2.customer.id, vehicleId: p2.vehicle.id, serviceTypeId: service, date: date2, time: '10:15', technicianMembershipId: tech }))).message).toMatch(/30-minute gap/);
    await createBooking(ws.ctx, { customerId: p2.customer.id, vehicleId: p2.vehicle.id, serviceTypeId: service, date: date2, time: '10:30', technicianMembershipId: tech });
    await updateRules(ws.ctx, { bufferMinutes: 0 });
  });

  it('cancelling inside the cancellation window needs permission to manage the calendar', async () => {
    const types = await listServiceTypes(ws.ctx);
    const p = await seedCustomerVehicle(ws, 'Late');
    const soon = new Date(Date.now() + 3 * 3_600_000);
    const b = await createBooking(ws.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, serviceTypeId: types.find((t) => t.name === 'Diagnostic')!.id, date: nextWeekday(5), time: '09:00' });
    await ownerQuery("UPDATE bookings SET starts_at = $2::timestamptz, ends_at = $2::timestamptz + interval '1 hour' WHERE id = $1", [b.id, soon]);
    await updateRules(ws.ctx, { cancelWindowHours: 24 });
    const advisor = await memberWithPermissions(ws, ['booking.view', 'booking.cancel']);
    const e = await err(cancelBooking(advisor.ctx, b.id, { reason: 'Customer called' }));
    expect(e.status).toBe(403);
    expect(e.message).toMatch(/within 24 hours/);
    const done = await cancelBooking(ws.ctx, b.id, { reason: 'Customer called' }); // the owner manages the calendar
    expect(done.status).toBe('CANCELLED');
    const audit = await ownerQuery<{ metadata: { lateCancellation?: boolean } }>("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'booking.cancelled' AND resource_id = $2", [ws.businessId, b.id]);
    expect(audit.rows[0]!.metadata.lateCancellation).toBe(true);
    await updateRules(ws.ctx, { cancelWindowHours: 0 });
  });

  it('rejects out-of-range rule values', async () => {
    expect((await err(updateRules(ws.ctx, { bufferMinutes: 9999 }))).status).toBe(422);
    expect((await err(updateRules(ws.ctx, { maxDailyBookings: 0 }))).status).toBe(422);
  });
});

describe('security settings', () => {
  it('invitations expire after the number of days the business chose', async () => {
    const roles = await ownerQuery<{ id: string }>("SELECT id FROM roles WHERE business_id IS NULL AND key = 'technician'");
    await updateSecuritySettings(ws.ctx, { invitationExpiryDays: 2 });
    await inviteMember(ws.ctx, { email: `invitee.${Date.now()}@example.test`, roleId: roles.rows[0]!.id });
    const m = (await ownerQuery<{ invite_expires_at: Date }>("SELECT invite_expires_at FROM memberships WHERE business_id = $1 AND status = 'INVITED' ORDER BY invited_at DESC LIMIT 1", [ws.businessId])).rows[0]!;
    const days = (m.invite_expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);
    expect((await err(updateSecuritySettings(ws.ctx, { invitationExpiryDays: 90 }))).status).toBe(422);
    await updateSecuritySettings(ws.ctx, { invitationExpiryDays: null });
  });

  it('a session older than the business limit must sign in again, in that business only', async () => {
    const mine = await createMemberCtx(ws, 'accounts');
    const other = await createWorkspace('Session Other');
    await updateSecuritySettings(ws.ctx, { sessionMaxHours: 1 });
    try {
      const auth = await authenticate(mine.ctx.token, mine.ctx.meta);
      expect((await resolveBusinessContext(auth!)).business.id).toBe(ws.businessId); // a fresh sign-in is fine
      await ownerQuery("UPDATE sessions SET created_at = now() - interval '3 hours' WHERE user_id = $1", [mine.user.id]);
      const stale = await authenticate(mine.ctx.token, mine.ctx.meta);
      expect((await err(resolveBusinessContext(stale!))).status).toBe(401);
      // another business with no limit is unaffected
      const auth2 = await authenticate(other.ctx.token, other.ctx.meta);
      expect((await resolveBusinessContext(auth2!)).business.id).toBe(other.businessId);
    } finally {
      await updateSecuritySettings(ws.ctx, { sessionMaxHours: null });
    }
    expect((await err(updateSecuritySettings(ws.ctx, { sessionMaxHours: 0 }))).status).toBe(422);
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(updateSecuritySettings(tech.ctx, { sessionMaxHours: 8 }))).status).toBe(403);
  });
});

describe('retention and reporting preferences', () => {
  it('financial retention can be lengthened, never shortened; the trash period is adjustable', async () => {
    const r = await getRetention(ws.ctx);
    expect(r.financialRetentionYears).toBeGreaterThanOrEqual(1);
    await updateRetention(ws.ctx, { financialRetentionYears: r.financialRetentionYears + 2, trashRetentionDays: 45 });
    const after = await getRetention(ws.ctx);
    expect(after).toMatchObject({ financialRetentionYears: r.financialRetentionYears + 2, trashRetentionDays: 45 });
    const e = await err(updateRetention(ws.ctx, { financialRetentionYears: r.financialRetentionYears }));
    expect(e.status).toBe(422);
    expect(JSON.stringify(e.details)).toMatch(/never shortened/);
    expect((await err(updateRetention(ws.ctx, { trashRetentionDays: 0 }))).status).toBe(422);
    const accounts = await createMemberCtx(ws, 'accounts');
    expect((await err(updateRetention(accounts.ctx, { trashRetentionDays: 10 }))).status).toBe(403);
    expect((await auditOf(ws, 'config.retention_changed')).rowCount).toBe(1);
  });

  it('reporting preferences change what reports use by default', async () => {
    await updateReportingSettings(ws.ctx, { reportDefaultRange: 'LAST_YEAR', slowMovingDays: 30, dashboardHiddenKpis: ['stock'] });
    const { runReport } = await import('@/server/reports/run');
    const r = await runReport(ws.ctx, 'revenue', {});
    expect(r.range!.preset).toBe('LAST_YEAR');
    const slow = await runReport(ws.ctx, 'slow_moving', {});
    expect(slow.notes.join(' ')).toMatch(/30 days/);
    expect((await err(updateReportingSettings(ws.ctx, { reportDefaultRange: 'CUSTOM' }))).status).toBe(422);
    expect((await err(updateReportingSettings(ws.ctx, { slowMovingDays: 3 }))).status).toBe(422);
    await updateReportingSettings(ws.ctx, { reportDefaultRange: 'THIS_MONTH', slowMovingDays: 90, dashboardHiddenKpis: [] });
  });
});

describe('services and job templates', () => {
  it('a service carries a checklist, default parts and a default price that become a document line', async () => {
    const part = await mkPart(ws, { costCents: 5000 }, 10);
    const s = await saveService(ws.ctx, null, { name: 'Custom brake package', description: 'Pads and discs', defaultDurationMin: 90, defaultPriceCents: 150_000, taxTreatment: 'STANDARD', checklist: ['Inspect pads', 'Bleed brakes'], defaultParts: [{ partId: part.id, quantity: 4 }] });
    expect(s).toMatchObject({ name: 'Custom brake package', defaultPriceCents: 150_000, checklist: ['Inspect pads', 'Bleed brakes'] });
    const list = await listServiceCatalogue(ws.ctx);
    expect(list.find((x) => x.id === s.id)!.parts[0]).toMatchObject({ quantity: 4, sku: part.sku });
    const line = await serviceLine(ws.ctx, s.id);
    expect(line).toMatchObject({ lineType: 'SERVICE', description: 'Custom brake package', unitPriceCents: 150_000, quantityMilli: 1000 });
    // the line is a copy: changing the price later does not change an invoice already made from it
    const p = await seedCustomerVehicle(ws, 'Svc');
    const d = await createInvoice(ws.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, lines: [line] });
    await saveService(ws.ctx, s.id, { defaultPriceCents: 999_999 });
    const inv = (await ownerQuery<{ total_cents: number }>('SELECT total_cents FROM invoices WHERE id = $1', [d.id])).rows[0]!;
    expect(inv.total_cents).toBeGreaterThan(0);
    expect(inv.total_cents).toBeLessThan(999_999);
    expect((await err(saveService(ws.ctx, null, { name: 'brake SERVICE', defaultDurationMin: 30 }))).status).toBe(422); // duplicate name
    expect((await err(saveService(ws.ctx, null, { name: 'Odd', defaultDurationMin: 1 }))).status).toBe(422);
    expect((await err(saveService(ws.ctx, null, { name: 'Odd2', defaultDurationMin: 30, defaultParts: [{ partId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] }))).status).toBe(422);
    await saveService(ws.ctx, s.id, { archived: true });
    expect((await err(serviceLine(ws.ctx, s.id))).status).toBe(404);
  });

  it('a job made from a template gets copies of its labour, parts and checklist, and keeps no link to the template', async () => {
    await ownerQuery("UPDATE finance_settings SET default_labour_rate_cents_per_hour = 60000 WHERE business_id = $1", [ws.businessId]);
    const part = await mkPart(ws, { costCents: 2000, sellPriceCents: 3500 }, 20);
    const types = await listServiceTypes(ws.ctx);
    const tpl = await saveJobTemplate(ws.ctx, null, {
      name: 'Minor service', serviceTypeId: types.find((t) => t.name === 'Minor service')!.id, estimatedMinutes: 120, checklist: ['Change oil', 'Replace filter'], inspectionFields: ['Tyre pressures'],
      labour: [{ description: 'Service labour', minutes: 90 }], parts: [{ partId: part.id, quantity: 2 }],
    });
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Tpl');
    const made = await createJobFromTemplate(ws.ctx, { templateId: tpl.id, customerId: customer.id, vehicleId: vehicle.id, arrived: true, isWalkIn: true, complaint: 'Due for service', mileageKm: 60_000 });
    expect(made.created).toBe(true);
    expect(made.copied).toEqual({ labour: 1, parts: 1, checklist: 3, skippedParts: 0 });
    const jobId = made.job.id;
    expect(made.job.serviceLabel).toBe('Minor service');
    const labour = (await ownerQuery<{ minutes: number; rate_cents_per_hour: number; total_cents: number }>('SELECT minutes, rate_cents_per_hour, total_cents FROM job_labour WHERE job_id = $1', [jobId])).rows[0]!;
    expect(labour).toMatchObject({ minutes: 90, rate_cents_per_hour: 60_000, total_cents: 90_000 });
    const parts = (await ownerQuery<{ quantity: number; status: string }>('SELECT quantity, status FROM job_parts WHERE job_id = $1', [jobId])).rows;
    expect(parts).toEqual([{ quantity: 2, status: 'RESERVED' }]);
    const note = (await ownerQuery<{ body: string; visibility: string }>('SELECT body, visibility FROM job_notes WHERE job_id = $1', [jobId])).rows[0]!;
    expect(note.visibility).toBe('INTERNAL');
    expect(note.body).toMatch(/\[ \] Change oil/);
    expect(note.body).toMatch(/\[ \] Inspect: Tyre pressures/);
    // changing or archiving the template afterwards does not touch the job
    await saveJobTemplate(ws.ctx, tpl.id, { labour: [{ description: 'Different', minutes: 10 }], parts: [], checklist: [] });
    await saveJobTemplate(ws.ctx, tpl.id, { archived: true });
    expect((await ownerQuery<{ minutes: number }>('SELECT minutes FROM job_labour WHERE job_id = $1', [jobId])).rows[0]!.minutes).toBe(90);
    expect((await ownerQuery('SELECT 1 FROM job_parts WHERE job_id = $1', [jobId])).rowCount).toBe(1);
    expect((await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM job_notes WHERE job_id = $1', [jobId])).rows[0]!.n).toBe(1);
    // an archived template cannot be used for new jobs
    expect((await err(createJobFromTemplate(ws.ctx, { templateId: tpl.id, customerId: customer.id, vehicleId: vehicle.id, arrived: true, isWalkIn: true }))).status).toBe(404);
    expect((await listJobTemplates(ws.ctx)).some((t) => t.id === tpl.id)).toBe(false);
  });

  it('needs the plan feature and permission', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(saveService(tech.ctx, null, { name: 'Nope', defaultDurationMin: 30 }))).status).toBe(403);
    expect((await err(saveJobTemplate(tech.ctx, null, { name: 'Nope' }))).status).toBe(403);
    const solo = await createWorkspace('Tpl Solo');
    await ownerQuery("UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, plan_id = (SELECT id FROM plans WHERE key = 'solo'), current_period_start = now(), current_period_end = now() + interval '30 days' WHERE business_id = $1", [solo.businessId]);
    solo.ctx = await businessContext(solo.owner);
    expect((await err(saveService(solo.ctx, null, { name: 'X', defaultDurationMin: 30 }))).status).toBe(402);
    expect((await err(saveJobTemplate(solo.ctx, null, { name: 'X' }))).status).toBe(402);
  });
});

describe('locations', () => {
  it('a location\'s own contact details go on its documents; the business\'s are used where it has none', async () => {
    const [loc] = await listLocations(ws.ctx);
    await ownerQuery("UPDATE businesses SET phone = '011 000 0000', email = 'main@biz.test' WHERE id = $1", [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    await renameLocation(ws.ctx, loc!.id, { name: loc!.name, phone: '021 555 1234', addressLine1: '5 Harbour Rd', city: 'Cape Town', email: '' });
    const p = await seedCustomerVehicle(ws, 'Loc');
    const d = await createInvoice(ws.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, locationId: loc!.id, lines: [L('Part', 1, 10_000)] });
    await finaliseInvoice(ws.ctx, d.id);
    const pdf = pdfText(await getInvoicePdf(ws.ctx, d.id).then((r) => r.pdf));
    expect(pdf).toContain('021 555 1234'); // the location's phone
    expect(pdf).toContain('5 Harbour Rd');
    expect(pdf).toContain('main@biz.test'); // no location email: the business's is used
    expect(pdf).not.toContain('011 000 0000');
    expect((await err(renameLocation(ws.ctx, loc!.id, { name: loc!.name, email: 'not-an-email' }))).status).toBe(422);
    const audit = await auditOf(ws, 'location.updated');
    expect(JSON.stringify(audit.rows[0]!.after)).toContain('021 555 1234');
  });
});

describe('settings never leak or bypass anything', () => {
  it('every settings change is audited with before and after, and carries no secret', async () => {
    for (const a of ['config.numbering_changed', 'config.labour_changed', 'config.jobs_changed', 'config.vehicles_changed', 'config.inventory_changed', 'config.reporting_changed', 'config.security_changed', 'config.retention_changed', 'config.service_changed', 'config.job_template_changed']) {
      const r = await ownerQuery<{ before: unknown; after: unknown; user_id: string }>('SELECT before, after, user_id FROM audit_logs WHERE business_id = $1 AND action = $2 LIMIT 1', [ws.businessId, a]);
      expect(r.rowCount, a).toBeGreaterThan(0);
      expect(r.rows[0]!.user_id).toBeTruthy();
      expect(JSON.stringify(r.rows[0])).not.toMatch(/password|secret|token|api[_-]?key|credential/i);
    }
  });

  it('settings of one business are invisible to another', async () => {
    const other = await createWorkspace('Settings Other');
    await upgradePlan(other, 'business');
    expect((await getNumbering(other.ctx)).kinds.find((k) => k.id === 'customer')).toMatchObject({ prefix: 'CUS', issued: 0 });
    expect((await listServiceCatalogue(other.ctx)).some((s) => s.name === 'Custom brake package')).toBe(false);
    expect((await listJobTemplates(other.ctx, { includeArchived: true })).length).toBe(0);
    await withTenant(other.businessId, async (tx) => {
      expect(await tx.jobTemplate.count()).toBe(0);
    });
  });
});
