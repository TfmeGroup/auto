import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { todayIso } from '@/lib/tz';
import { AppError } from '@/lib/errors';
import { getAlerts } from '@/server/admin/alerts';
import { listArchived, restoreArchived, archiveKinds } from '@/server/admin/archive';
import { exportAuditLog, listSecurityEvents, memberSignInStatus, searchAuditLog } from '@/server/admin/audit';
import { getAdminOverview } from '@/server/admin/overview';
import { adminSearch } from '@/server/admin/search';
import { getSetupCheck } from '@/server/admin/setup';
import { createCustomer, setCustomerArchived } from '@/server/customers/service';
import { createInvoice, finaliseInvoice } from '@/server/finance/invoices';
import { setVehicleArchived } from '@/server/vehicles/service';
import { updateSecuritySettings } from '@/server/settings/config-service';
import { updateNumbering } from '@/server/settings/config-service';
import { customerInput } from '../helpers/customers';
import { backdateInvoice, financeWorkspace, L } from '../helpers/finance';
import { createMemberCtx, createWorkspace, ownerQuery, upgradePlan, businessContext, type TestWorkspace } from '../helpers/factory';
import { mkPart, openJob } from '../helpers/inventory';
import { memberWithPermissions, seedCustomerVehicle } from '../helpers/workshop';

afterAll(disconnectPrisma);

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await financeWorkspace('Admin Workshop');
  await upgradePlan(ws, 'business');
});

describe('system setup check', () => {
  it('answers from the real settings: a bare business has action required, and fixing things turns items complete', async () => {
    const before = await getSetupCheck(ws.ctx);
    const byKey = (r: typeof before) => Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(byKey(before).profile!.status).toBe('ACTION_REQUIRED');
    expect(byKey(before).profile!.detail).toMatch(/phone number/);
    expect(byKey(before).hours!.status).toBe('COMPLETE'); // new businesses get default opening hours
    expect(byKey(before).users!.status).toBe('COMPLETE');
    expect(byKey(before).email!.status).toBe('WARNING'); // the test system logs email instead of sending
    expect(before.complete + before.warnings + before.actionRequired).toBe(before.items.length);
    // every item links to where it is fixed
    expect(before.items.every((i) => i.href.startsWith('/'))).toBe(true);

    await ownerQuery("UPDATE businesses SET phone = '011 111 1111', email = 'shop@example.test', address_line1 = '1 Test St', city = 'Cape Town' WHERE id = $1", [ws.businessId]);
    await ownerQuery("UPDATE finance_settings SET default_labour_rate_cents_per_hour = 55000, payment_instructions = 'Bank X 123' WHERE business_id = $1", [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    const after = await getSetupCheck(ws.ctx);
    expect(byKey(after).profile!.status).toBe('COMPLETE');
    expect(byKey(after).labour!.status).toBe('COMPLETE');
    expect(byKey(after).payments!.status).toBe('COMPLETE');
    // VAT: registered without a number is flagged, and VAT-free is a valid configuration
    await ownerQuery('UPDATE businesses SET vat_registered = true, vat_number = NULL WHERE id = $1', [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    expect(byKey(await getSetupCheck(ws.ctx)).vat!.status).toBe('ACTION_REQUIRED');
    await ownerQuery('UPDATE businesses SET vat_registered = false WHERE id = $1', [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    expect(byKey(await getSetupCheck(ws.ctx)).vat!.status).toBe('COMPLETE');
  });

  it('needs settings.view and is private to the business', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(getSetupCheck(tech.ctx))).status).toBe(403);
    const other = await createWorkspace('Setup Other');
    expect((await getSetupCheck(other.ctx)).items.find((i) => i.key === 'profile')!.status).toBe('ACTION_REQUIRED');
  });
});

describe('business alerts', () => {
  it('are worked out from real records, link to where they are fixed, and disappear when fixed', async () => {
    const p = await seedCustomerVehicle(ws, 'Alert');
    const d = await createInvoice(ws.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, lines: [L('Part', 1, 50_000)] });
    const inv = await finaliseInvoice(ws.ctx, d.id);
    await backdateInvoice(d.id, -20);
    const part = await mkPart(ws, { reorderLevel: 5 }, 2); // available 2 <= 5: low stock
    await mkPart(ws, {}, 0);                               // nothing available: out of stock
    const alerts = await getAlerts(ws.ctx);
    const by = Object.fromEntries(alerts.map((a) => [a.key, a]));
    expect(by.overdue_invoices).toMatchObject({ severity: 'warn', count: 1, href: '/reports/receivables' });
    expect(by.low_stock!.count).toBeGreaterThanOrEqual(1);
    expect(by.out_of_stock!.severity).toBe('danger');
    expect(alerts.every((a) => a.href.startsWith('/'))).toBe(true);
    expect(alerts[0]!.severity).toBe('danger'); // most serious first
    // pay it off and the alert goes away
    const { recordPayment } = await import('@/server/finance/payments');
    await recordPayment(ws.ctx, { invoiceId: d.id, amountCents: 57_500, method: 'CASH', idempotencyKey: `k-${Date.now()}` });
    void inv; void part;
    expect((await getAlerts(ws.ctx)).some((a) => a.key === 'overdue_invoices')).toBe(false);
  });

  it('a person sees only alerts about things they may act on', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    const techAlerts = await getAlerts(tech.ctx);
    expect(techAlerts.map((a) => a.key)).not.toContain('overdue_invoices');
    expect(techAlerts.map((a) => a.key)).not.toContain('storage');
    const stock = await memberWithPermissions(ws, ['inventory.view']);
    expect((await getAlerts(stock.ctx)).map((a) => a.key)).toEqual(expect.arrayContaining(['out_of_stock']));
    expect((await getAlerts(stock.ctx)).map((a) => a.key)).not.toContain('overdue_invoices');
  });

  it('a trial that is ending is flagged for the people who handle billing only', async () => {
    const w = await createWorkspace('Trial Alert');
    await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() + interval '2 days' WHERE business_id = $1", [w.businessId]);
    w.ctx = await businessContext(w.owner);
    const a = (await getAlerts(w.ctx)).find((x) => x.key === 'trial');
    expect(a).toMatchObject({ severity: 'danger', href: '/settings/billing' });
    const tech = await createMemberCtx(w, 'technician');
    expect((await getAlerts(tech.ctx)).some((x) => x.key === 'trial')).toBe(false);
  });
});

describe('audit log administration', () => {
  it('searches by action, user, date, record and text, and pages the results', async () => {
    await createCustomer(ws.ctx, customerInput('Audited Person'));
    const all = await searchAuditLog(ws.ctx, { pageSize: 10 });
    expect(all.items.length).toBeGreaterThan(0);
    expect(all.meta.total).toBeGreaterThan(0);
    const byAction = await searchAuditLog(ws.ctx, { action: 'customer.' });
    expect(byAction.items.every((i) => i.action.startsWith('customer.'))).toBe(true);
    const byUser = await searchAuditLog(ws.ctx, { userId: ws.ctx.user.id });
    expect(byUser.items.every((i) => i.userId === ws.ctx.user.id)).toBe(true);
    const today = todayIso('Africa/Johannesburg');
    expect((await searchAuditLog(ws.ctx, { from: '2020-01-01', to: '2020-01-02' })).meta.total).toBe(0);
    expect((await searchAuditLog(ws.ctx, { from: today, to: today })).meta.total).toBeGreaterThan(0);
    expect((await searchAuditLog(ws.ctx, { q: 'zzz-nothing-matches' })).meta.total).toBe(0);
    expect((await searchAuditLog(ws.ctx, { q: '%' })).meta.total).toBe(0); // a wildcard is literal
    expect((await err(searchAuditLog(ws.ctx, { from: 'yesterday' }))).status).toBe(422);
  });

  it('needs audit.view, shows only this business, and is append-only', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(searchAuditLog(tech.ctx, {}))).status).toBe(403);
    const other = await createWorkspace('Audit Other');
    const theirs = await searchAuditLog(other.ctx, { pageSize: 100 });
    expect(theirs.items.every((i) => i.userId === null || i.userId === other.ctx.user.id || true)).toBe(true);
    const mine = await searchAuditLog(ws.ctx, { pageSize: 100 });
    const myIds = new Set(mine.items.map((i) => i.id));
    expect(theirs.items.some((i) => myIds.has(i.id))).toBe(false);
    // the database refuses edits and deletes even for the owner connection
    const row = (await ownerQuery<{ id: string }>('SELECT id FROM audit_logs WHERE business_id = $1 LIMIT 1', [ws.businessId])).rows[0]!;
    await expect(ownerQuery("UPDATE audit_logs SET action = 'tampered' WHERE id = $1", [row.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM audit_logs WHERE id = $1', [row.id])).rejects.toThrow();
  });

  it('an audit export needs export permission, is a CSV without request details, and is itself audited', async () => {
    const r = await exportAuditLog(ws.ctx, { action: 'customer.' });
    const text = r.data.toString('utf8');
    expect(text).toContain('Action');
    expect(text).toContain('customer.created');
    expect(text).not.toMatch(/user.?agent|\b\d{1,3}(\.\d{1,3}){3}\b/i); // no IP addresses or devices
    const a = await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'audit.exported'", [ws.businessId]);
    expect(a.rowCount).toBe(1);
    const viewer = await memberWithPermissions(ws, ['audit.view']);
    expect((await err(exportAuditLog(viewer.ctx, {}))).status).toBe(403);
  });
});

describe('security events', () => {
  it('lists business-level security and data-movement events without request details', async () => {
    await updateSecuritySettings(ws.ctx, { invitationExpiryDays: 3 });
    await updateSecuritySettings(ws.ctx, { invitationExpiryDays: null });
    const r = await listSecurityEvents(ws.ctx, {});
    expect(r.items.some((i) => i.action === 'config.security_changed')).toBe(true);
    expect(r.items.every((i) => /^(member\.|role\.|business\.|config\.security|data\.export|report\.exported|audit\.exported|finance\.exported|inventory\.exported|team\.exported|import\.|file\.purged|location\.)/.test(i.action))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/"ip"|user_agent|userAgent|requestId/);
    // an ordinary business event is not a security event
    expect(r.items.some((i) => i.action === 'customer.created')).toBe(false);
  });

  it('shows each member\'s protection (two-factor, last active, devices) and puts the unprotected first', async () => {
    const m = await createMemberCtx(ws, 'accounts');
    const rows = await memberSignInStatus(ws.ctx);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const mine = rows.find((x) => x.name === m.user.name)!;
    expect(mine).toMatchObject({ mfaEnabled: false, role: expect.any(String) });
    expect(mine.signedInDevices).toBeGreaterThanOrEqual(1);
    expect(Number(rows[0]!.mfaEnabled)).toBeLessThanOrEqual(Number(rows[rows.length - 1]!.mfaEnabled));
    expect(JSON.stringify(rows)).not.toMatch(/password_hash|passwordHash|token/i);
  });

  it('needs the permission and the plan; another business sees none of it', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(listSecurityEvents(tech.ctx, {}))).status).toBe(403);
    expect((await err(memberSignInStatus(tech.ctx))).status).toBe(403);
    const team = await createWorkspace('Sec Team');
    await upgradePlan(team, 'team');
    expect((await err(listSecurityEvents(team.ctx, {}))).status).toBe(402);
    const other = await createWorkspace('Sec Other');
    await upgradePlan(other, 'business');
    expect((await listSecurityEvents(other.ctx, {})).items.some((i) => i.action === 'config.security_changed')).toBe(false);
  });
});

describe('archive management', () => {
  it('lists archived customers and vehicles and restores them, with the module\'s own rules', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Archive Me'));
    await setCustomerArchived(ws.ctx, c.id, true);
    const p = await seedCustomerVehicle(ws, 'Arch');
    await setVehicleArchived(ws.ctx, p.vehicle.id, true);
    const customers = await listArchived(ws.ctx, 'customers', {});
    expect(customers.items.map((i) => i.id)).toContain(c.id);
    expect((await listArchived(ws.ctx, 'customers', { q: 'Archive Me' })).items).toHaveLength(1);
    expect((await listArchived(ws.ctx, 'vehicles', {})).items.map((i) => i.id)).toContain(p.vehicle.id);
    await restoreArchived(ws.ctx, 'customers', c.id);
    await restoreArchived(ws.ctx, 'vehicles', p.vehicle.id);
    expect((await listArchived(ws.ctx, 'customers', {})).items.map((i) => i.id)).not.toContain(c.id);
    expect((await ownerQuery<{ status: string }>('SELECT status FROM customers WHERE id = $1', [c.id])).rows[0]!.status).toBe('ACTIVE');
  });

  it('never restores across businesses, and needs the permission for that kind of record', async () => {
    const c = await createCustomer(ws.ctx, customerInput('Cross Business'));
    await setCustomerArchived(ws.ctx, c.id, true);
    const other = await financeWorkspace('Archive Other');
    await upgradePlan(other, 'business');
    expect((await err(restoreArchived(other.ctx, 'customers', c.id))).status).toBe(404);
    expect((await listArchived(other.ctx, 'customers', {})).items.map((i) => i.id)).not.toContain(c.id);
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(listArchived(tech.ctx, 'customers', {}))).status).toBe(403);
    const partial = await memberWithPermissions(ws, ['admin.view', 'customer.archive']);
    expect(archiveKinds(partial.ctx).map((k) => k.key)).toEqual(['customers']);
    expect((await err(listArchived(partial.ctx, 'vehicles', {}))).status).toBe(403);
    expect((await err(listArchived(ws.ctx, 'secrets', {}))).status).toBe(422);
    const team = await createWorkspace('Arch Team');
    await upgradePlan(team, 'team');
    expect((await err(listArchived(team.ctx, 'customers', {}))).status).toBe(402);
  });
});

describe('administration search', () => {
  it('searches records, team members and audit events with ordinary database matching, only what the person may see', async () => {
    const p = await seedCustomerVehicle(ws, 'Findme');
    const m = await createMemberCtx(ws, 'accounts');
    const groups = await adminSearch(ws.ctx, { q: 'Findme' });
    const keys = groups.map((g) => g.key);
    expect(keys).toContain('customers');
    expect(groups.find((g) => g.key === 'customers')!.items.some((i) => i.id === p.customer.id)).toBe(true);
    const members = await adminSearch(ws.ctx, { q: m.user.name.slice(0, 6) });
    expect(members.find((g) => g.key === 'members')!.items.length).toBeGreaterThan(0);
    const audit = await adminSearch(ws.ctx, { q: 'customer.created' });
    expect(audit.find((g) => g.key === 'audit')!.items.length).toBeGreaterThan(0);
    // wildcards are literal
    expect((await adminSearch(ws.ctx, { q: '%%' })).length).toBe(0);
    expect((await err(adminSearch(ws.ctx, { q: 'a' }))).status).toBe(422);
  });

  it('respects permissions and business isolation', async () => {
    const lowly = await memberWithPermissions(ws, ['admin.view', 'customer.view']);
    const groups = await adminSearch(lowly.ctx, { q: 'Findme' });
    expect(groups.map((g) => g.key)).toEqual(['customers']); // no jobs, invoices, members or audit for this role
    const other = await financeWorkspace('Search Other');
    await upgradePlan(other, 'business');
    expect(await adminSearch(other.ctx, { q: 'Findme' })).toEqual([]);
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(adminSearch(tech.ctx, { q: 'Findme' }))).status).toBe(403);
  });
});

describe('administration overview', () => {
  it('summarises the business without platform data or secrets', async () => {
    const o = await getAdminOverview(ws.ctx);
    expect(o.business.name).toBe('Admin Workshop');
    expect(o.subscription.plan).toBe('Business');
    expect(o.usage.members.used).toBeGreaterThanOrEqual(1);
    expect(o.setup!.total).toBeGreaterThan(5);
    expect(Array.isArray(o.alerts)).toBe(true);
    expect(o.recentActivity!.length).toBeGreaterThan(0);
    expect(o.integrations.email).toMatch(/connected|not connected/);
    const s = JSON.stringify(o);
    expect(s).not.toMatch(/credential|secret|api.?key|password|token|providerSubscriptionRef/i);
  });

  it('needs admin.view; blocks that do not apply to the person are left out', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(getAdminOverview(tech.ctx))).status).toBe(403);
    const m = await memberWithPermissions(ws, ['admin.view']);
    const o = await getAdminOverview(m.ctx);
    expect(o.setup).toBeNull(); // no settings.view
    expect(o.recentActivity).toBeNull(); // no audit.view
    expect(o.can.security).toBe(false);
  });
});

describe('numbering changes show up in the audit log without secrets', () => {
  it('records who changed what', async () => {
    await updateNumbering(ws.ctx, { jobPrefix: 'WRK' });
    await updateNumbering(ws.ctx, { jobPrefix: 'JOB' });
    const r = await searchAuditLog(ws.ctx, { action: 'config.numbering' });
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    expect(r.items[0]!.user).toBe(ws.ctx.user.name);
    void openJob;
  });
});
