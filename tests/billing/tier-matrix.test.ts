import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { ALL_FEATURES, type FeatureKey } from '@/server/billing/features';
import { getEntitlements } from '@/server/billing/entitlements';
import { getBillingOverview } from '@/server/billing/overview';
import { getPlatformSettings } from '@/server/settings/platform';
import { createLocation } from '@/server/locations/service';
import { inviteMember } from '@/server/memberships/service';
import { createSavedReport } from '@/server/reports/saved';
import { GET as customersGet, POST as customersPost } from '@/app/api/v1/customers/route';
import { POST as customRun } from '@/app/api/v1/reports/custom/run/route';
import { POST as schedulePost } from '@/app/api/v1/reports/schedules/route';
import { POST as poPost } from '@/app/api/v1/purchase-orders/route';
import { POST as transferPost } from '@/app/api/v1/transfers/route';
import { GET as entitlementsGet } from '@/app/api/v1/billing/entitlements/route';
import { call } from '../helpers/http';
import { businessContext, createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { customerInput } from '../helpers/customers';

afterAll(disconnectPrisma);

/**
 * The commercial tiers as the specification states them, written out independently of plans.ts so that any drift in the
 * catalogue (a feature moved between tiers, a limit changed) fails here.
 */
const TEAM_FEATURES: FeatureKey[] = [
  'data_export', 'advanced_inventory', 'advanced_communication', 'mfa_enforcement', 'online_payments', 'payment_reminders', 'financial_reports',
  'purchase_orders', 'barcode_workflows', 'technician_management', 'advanced_documents', 'communication_history', 'custom_templates', 'service_reminders',
  'sms_notifications', 'advanced_reports', 'advanced_settings',
];
const TIERS: Record<string, { members: number; locations: number; features: FeatureKey[] }> = {
  solo: { members: 1, locations: 1, features: ['data_export'] },
  team: { members: 10, locations: 1, features: TEAM_FEATURES },
  business: { members: 35, locations: 10, features: ALL_FEATURES },
  custom: { members: 36, locations: 50, features: ALL_FEATURES },
};

async function setPlan(ws: TestWorkspace, planKey: string, sets = '') {
  await ownerQuery(
    `UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, past_due_since = NULL, cancel_at_period_end = false,
            plan_id = (SELECT id FROM plans WHERE key = $2), current_period_start = now(), current_period_end = now() + interval '30 days' ${sets} WHERE business_id = $1`,
    [ws.businessId, planKey],
  );
  ws.ctx = await businessContext(ws.owner);
}
const setState = async (ws: TestWorkspace, sql: string) => {
  await ownerQuery(`UPDATE subscriptions SET ${sql} WHERE business_id = $1`, [ws.businessId]);
  ws.ctx = await businessContext(ws.owner);
};
const days = (n: number) => `now() + interval '${n} days'`;

describe('the 14-day trial is the same for every business and belongs to the business, not the account', () => {
  it('a new business starts TRIALING for 14 days with the whole product, decided on the server', async () => {
    const ws = await createWorkspace('Trial Matrix Co');
    const s = ws.ctx.subscription;
    expect(s.status).toBe('TRIALING');
    expect(s.canWrite).toBe(true);
    expect(s.trialDaysRemaining).toBeGreaterThanOrEqual(13);
    expect(s.trialDaysRemaining).toBeLessThanOrEqual(14);
    expect(new Set(s.features)).toEqual(new Set(ALL_FEATURES));
    const row = (await ownerQuery<{ d: number }>('SELECT extract(epoch FROM (trial_ends_at - trial_started_at))/86400 AS d FROM subscriptions WHERE business_id = $1', [ws.businessId])).rows[0]!;
    expect(Math.round(Number(row.d))).toBe(14);
    // the account itself carries no trial or plan
    const cols = (await ownerQuery<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")).rows.map((r) => r.column_name);
    expect(cols.filter((c) => /trial|plan|subscription/i.test(c))).toEqual([]);
  });

  it('a second business of the same person gets its own, separate trial', async () => {
    const a = await createWorkspace('Trial Own A');
    const before = a.ctx.subscription.trialEndsAt!.getTime();
    const subs = (await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM subscriptions WHERE business_id = $1', [a.businessId])).rows[0]!.n;
    expect(subs).toBe(1);
    expect(before).toBeGreaterThan(Date.now());
  });
});

describe.each(Object.entries(TIERS))('%s tier', (tier, spec) => {
  let ws: TestWorkspace;
  it('carries exactly the specified limits and features', async () => {
    ws = await createWorkspace(`Matrix ${tier}`);
    await setPlan(ws, tier);
    const s = ws.ctx.subscription;
    expect(s.limits.members).toBe(spec.members);
    expect(s.limits.locations).toBe(spec.locations);
    expect(new Set(s.features)).toEqual(new Set(spec.features));
  });

  it('the central entitlement service answers consistently with those features and limits', async () => {
    const e = await getEntitlements(ws.ctx);
    const has = (k: FeatureKey) => spec.features.includes(k);
    expect(e.plan.key).toBe(tier);
    expect(e.limits).toMatchObject({ members: spec.members, locations: spec.locations });
    expect(e.can.createCustomReport).toBe(has('custom_reports'));
    expect(e.can.scheduleReports).toBe(has('scheduled_reports'));
    expect(e.can.useSms).toBe(has('sms_notifications'));
    expect(e.can.useWhatsApp).toBe(has('whatsapp_notifications'));
    expect(e.can.usePurchaseOrders).toBe(has('purchase_orders'));
    expect(e.can.transferStock).toBe(has('multi_location'));
    expect(e.can.createCustomRole).toBe(has('custom_roles'));
    expect(e.can.createLocation).toBe(has('multi_location'));
    expect(e.can.inviteMember).toBe(spec.members > 1);
    expect(e.remaining.members).toBe(spec.members - 1);
    expect(e.overLimit).toEqual([]);
    const api = await call(entitlementsGet, { token: ws.ctx.token });
    expect(api.status).toBe(200);
    expect(api.body.data.limits.members).toBe(spec.members);
    expect(JSON.stringify(api.body)).not.toMatch(/provider|token|secret|credential/i);
  });

  it('enforces features on the server: an entitled call gets through, a call the plan lacks is a 402', async () => {
    const t = ws.ctx.token;
    const expectGate = (r: { status: number; body: { error?: { code: string } } }, feature: FeatureKey) => {
      if (spec.features.includes(feature)) expect(r.status, feature).not.toBe(402);
      else {
        expect(r.status, feature).toBe(402);
        expect(r.body.error?.code).toBe('FEATURE_NOT_IN_PLAN');
      }
    };
    expectGate(await call(customRun, { method: 'POST', token: t, body: { name: 'x', config: { source: 'jobs', fields: ['jobNumber'] } } }), 'custom_reports');
    expectGate(await call(schedulePost, { method: 'POST', token: t, body: {} }), 'scheduled_reports');
    expectGate(await call(poPost, { method: 'POST', token: t, body: {} }), 'purchase_orders');
    expectGate(await call(transferPost, { method: 'POST', token: t, body: {} }), 'multi_location');
  });

  it('the member limit is enforced by the server, not the screen', async () => {
    const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    const room = spec.members - 1;
    const toAdd = Math.min(room, 3); // enough to prove counting without creating 35 people
    for (let i = 0; i < toAdd; i++) await inviteMember(ws.ctx, { email: `m${tier}${i}.${Date.now()}@example.test`, roleId: role.id });
    if (room <= toAdd) {
      await expect(inviteMember(ws.ctx, { email: `over.${tier}.${Date.now()}@example.test`, roleId: role.id })).rejects.toMatchObject({ status: 402, code: 'PLAN_LIMIT_REACHED' });
    } else {
      expect((await getEntitlements(ws.ctx)).can.inviteMember).toBe(true);
    }
  });

  it('works in every subscription state exactly as the lifecycle says: writes until suspended or expired, reads always, data kept', async () => {
    const settings = await getPlatformSettings();
    const states: [string, string, boolean][] = [
      ['ACTIVE', `status = 'ACTIVE', past_due_since = NULL, current_period_end = ${days(20)}`, true],
      ['PAST_DUE', `status = 'PAST_DUE', past_due_since = now() - interval '1 day', current_period_end = ${days(-1)}`, true],
      ['GRACE_PERIOD', `status = 'PAST_DUE', past_due_since = now() - interval '${settings.pastDueRetryDays + 1} days', current_period_end = ${days(-9)}`, true],
      ['CANCELED', `status = 'CANCELED', cancel_at_period_end = true, past_due_since = NULL, current_period_end = ${days(5)}`, true],
      ['SUSPENDED', `status = 'SUSPENDED', past_due_since = now() - interval '90 days'`, false],
      ['EXPIRED', `status = 'CANCELED', cancel_at_period_end = true, past_due_since = NULL, current_period_end = ${days(-3)}`, false],
    ];
    const customers = (await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]!.n;
    for (const [expected, sql, writable] of states) {
      await setState(ws, sql);
      expect(ws.ctx.subscription.status, `${tier} ${expected}`).toBe(expected);
      expect(ws.ctx.subscription.canWrite, `${tier} ${expected} canWrite`).toBe(writable);
      const read = await call(customersGet, { token: ws.ctx.token });
      expect(read.status, `${tier} ${expected} read`).toBe(200);
      const write = await call(customersPost, { method: 'POST', token: ws.ctx.token, body: customerInput(`State ${tier} ${expected}`) });
      expect(write.status, `${tier} ${expected} write`).toBe(writable ? 201 : 402);
      if (!writable) expect(write.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
      expect(new Set(ws.ctx.subscription.features), `${tier} ${expected} features`).toEqual(new Set(spec.features));
    }
    // nothing was deleted by any state change, and paying again restores everything
    const after = (await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]!.n;
    expect(after).toBeGreaterThanOrEqual(customers);
    await setPlan(ws, tier);
    expect(ws.ctx.subscription.canWrite).toBe(true);
    expect((await call(customersPost, { method: 'POST', token: ws.ctx.token, body: customerInput(`Restored ${tier}`) })).status).toBe(201);
  });

  it('an expired trial is read-only with data intact, and upgrading restores the plan', async () => {
    const t = await createWorkspace(`Expired trial ${tier}`);
    await call(customersPost, { method: 'POST', token: t.ctx.token, body: customerInput('Kept customer') });
    await setState(t, `trial_ends_at = now() - interval '1 day'`);
    expect(t.ctx.subscription.status).toBe('EXPIRED');
    expect((await call(customersPost, { method: 'POST', token: t.ctx.token, body: customerInput('Blocked') })).status).toBe(402);
    expect((await call(customersGet, { token: t.ctx.token })).body.data).toHaveLength(1);
    await setPlan(t, tier);
    expect(t.ctx.subscription.canWrite).toBe(true);
    expect(t.ctx.subscription.planKey).toBe(tier);
  });
});

describe('downgrading keeps everything and only restricts what is no longer included', () => {
  it('Business -> Solo: data stays, the business is shown as over its limits, nothing new can be added', async () => {
    const ws = await createWorkspace('Downgrade Matrix Co');
    await setPlan(ws, 'business');
    const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    const branch = await createLocation(ws.ctx, { name: 'Second branch' });
    await inviteMember(ws.ctx, { email: `down.${Date.now()}@example.test`, roleId: role.id });
    const staff = await createMemberCtx(ws, 'technician');
    const saved = await createSavedReport(ws.ctx, { kind: 'STANDARD', reportKey: 'invoices', name: 'Kept report', config: { preset: 'THIS_YEAR' } });
    const counts = async () => (await ownerQuery<Record<string, number>>(
      `SELECT (SELECT count(*) FROM locations WHERE business_id = $1)::int AS locations,
              (SELECT count(*) FROM memberships WHERE business_id = $1)::int AS members,
              (SELECT count(*) FROM saved_reports WHERE business_id = $1)::int AS reports`, [ws.businessId])).rows[0]!;
    const before = await counts();

    await setPlan(ws, 'solo');
    expect(await counts()).toEqual(before); // nothing deleted

    const e = await getEntitlements(ws.ctx);
    expect(e.overLimit.map((o) => o.kind).sort()).toEqual(['locations', 'members']);
    expect(e.can).toMatchObject({ inviteMember: false, createLocation: false, createCustomReport: false, scheduleReports: false, transferStock: false });
    const overview = await getBillingOverview(ws.ctx);
    expect(overview.overLimit.map((o) => o.kind).sort()).toEqual(['locations', 'members']);

    // creating more is refused with a reason; existing records are still there and usable
    await expect(createLocation(ws.ctx, { name: 'Third branch' })).rejects.toMatchObject({ status: 402 });
    await expect(inviteMember(ws.ctx, { email: `down2.${Date.now()}@example.test`, roleId: role.id })).rejects.toMatchObject({ status: 402 });
    expect((await call(customRun, { method: 'POST', token: ws.ctx.token, body: { name: 'x', config: { source: 'jobs', fields: ['jobNumber'] } } })).status).toBe(402);
    const active = (await ownerQuery<{ n: number }>("SELECT count(*)::int AS n FROM locations WHERE business_id = $1 AND status = 'ACTIVE' AND id = $2", [ws.businessId, branch.id])).rows[0]!.n;
    expect(active).toBe(1);
    expect((await ownerQuery<{ status: string }>('SELECT status FROM memberships WHERE id = $1', [staff.ctx.membership.id])).rows[0]!.status).toBe('ACTIVE'); // existing people keep working
    expect((await ownerQuery('SELECT 1 FROM saved_reports WHERE id = $1', [saved.id])).rowCount).toBe(1);
    expect((await call(customersGet, { token: ws.ctx.token })).status).toBe(200);

    // upgrading again lifts the restrictions with nothing to rebuild
    await setPlan(ws, 'business');
    const up = await getEntitlements(ws.ctx);
    expect(up.overLimit).toEqual([]);
    expect(up.can).toMatchObject({ inviteMember: true, createLocation: true, createCustomReport: true });
    expect(await counts()).toEqual(before);
  });
});

describe('a custom plan takes its limits from the contract, not from the catalogue or the client', () => {
  it('uses the overrides for members, locations and storage', async () => {
    const ws = await createWorkspace('Custom Contract Co');
    await setPlan(ws, 'custom', ', override_max_members = 60, override_max_locations = 12, override_max_storage_mb = 1000');
    const e = await getEntitlements(ws.ctx);
    expect(e.limits).toEqual({ members: 60, locations: 12, storageMb: 1000 });
    expect(e.usage.storage.limitBytes).toBe(1000 * 1024 * 1024);
    expect(e.can.createCustomReport).toBe(true);
  });
});
