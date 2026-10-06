import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { applyEvent, canWriteIn, deriveStatus, trialPhase, type SubState } from '@/server/billing/state-machine';
import { PLATFORM_DEFAULTS } from '@/server/settings/platform';
import { inviteMember, changeMemberStatus } from '@/server/memberships/service';
import { uploadFile } from '@/server/files/service';
import { createCustomer } from '@/server/customers/service';
import { POST as createCustomerRoute, GET as listCustomersRoute } from '@/app/api/v1/customers/route';
import { GET as billingRoute } from '@/app/api/v1/billing/route';
import { POST as inviteRoute } from '@/app/api/v1/members/route';
import { call } from '../helpers/http';
import { businessContext, createMemberCtx, createWorkspace, ownerQuery, uniqueEmail, type TestWorkspace } from '../helpers/factory';
import { customerInput } from '../helpers/customers';
import { pngOf } from '../helpers/images';

afterAll(disconnectPrisma);

const DAY = 86_400_000;
const now = new Date('2026-06-15T12:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);
const S = PLATFORM_DEFAULTS; // retry 3 days, grace 7 days

const base: SubState = { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: at(10), pastDueSince: null, convertedAt: null };
const eff = (over: Partial<SubState>, when = now) => deriveStatus({ ...base, ...over }, when, S);

describe('subscription state machine: deriveStatus (deterministic, computed from dates)', () => {
  it('trial', () => {
    expect(eff({ status: 'TRIALING', trialEndsAt: at(3), currentPeriodEnd: null })).toBe('TRIALING');
    expect(eff({ status: 'TRIALING', trialEndsAt: at(-0.01), currentPeriodEnd: null })).toBe('EXPIRED');
    expect(eff({ status: 'TRIALING', trialEndsAt: null, currentPeriodEnd: null })).toBe('EXPIRED'); // fail closed
  });

  it('active stays active inside its paid period (and for a day of renewal tolerance)', () => {
    expect(eff({})).toBe('ACTIVE');
    expect(eff({ currentPeriodEnd: at(-0.5) })).toBe('ACTIVE');
  });

  it('past due -> grace -> suspended, driven by the delinquency clock', () => {
    const since = (daysAgo: number) => ({ status: 'PAST_DUE' as const, pastDueSince: at(-daysAgo) });
    expect(eff(since(0.1))).toBe('PAST_DUE');
    expect(eff(since(2.9))).toBe('PAST_DUE');
    expect(eff(since(3.1))).toBe('GRACE_PERIOD');
    expect(eff(since(9.9))).toBe('GRACE_PERIOD');
    expect(eff(since(10.1))).toBe('SUSPENDED');
  });

  it('a lapsed period with no renewal starts the same clock automatically (no webhook needed)', () => {
    expect(eff({ currentPeriodEnd: at(-2) })).toBe('PAST_DUE'); // 1 day tolerance, then past due
    expect(eff({ currentPeriodEnd: at(-5) })).toBe('GRACE_PERIOD');
    expect(eff({ currentPeriodEnd: at(-12) })).toBe('SUSPENDED');
  });

  it('suspended stays suspended until a payment clears it; cancelled works to the paid-through date', () => {
    expect(eff({ status: 'SUSPENDED' })).toBe('SUSPENDED');
    expect(eff({ status: 'CANCELED', currentPeriodEnd: at(5) })).toBe('CANCELED');
    expect(eff({ status: 'CANCELED', currentPeriodEnd: at(-1) })).toBe('EXPIRED');
    expect(eff({ status: 'EXPIRED' })).toBe('EXPIRED');
  });

  it('honours configurable windows', () => {
    const long = deriveStatus({ ...base, status: 'PAST_DUE', pastDueSince: at(-5) }, now, { pastDueRetryDays: 10, graceDays: 5 });
    expect(long).toBe('PAST_DUE');
  });

  it('read-only statuses are exactly EXPIRED and SUSPENDED', () => {
    for (const s of ['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED'] as const) expect(canWriteIn(s)).toBe(true);
    for (const s of ['EXPIRED', 'SUSPENDED'] as const) expect(canWriteIn(s)).toBe(false);
  });
});

describe('subscription state machine: events', () => {
  const t = (o: Partial<SubState>): SubState => ({ ...base, ...o });

  it('PAYMENT_SUCCEEDED activates, clears delinquency, and marks conversion once', () => {
    const p = applyEvent(t({ status: 'TRIALING', trialEndsAt: at(2) }), { type: 'PAYMENT_SUCCEEDED', periodEnd: at(30) }, now);
    expect(p).toMatchObject({ status: 'ACTIVE', pastDueSince: null, currentPeriodEnd: at(30), cancelAtPeriodEnd: false, convertedAt: now });
    const again = applyEvent(t({ convertedAt: at(-40) }), { type: 'PAYMENT_SUCCEEDED', periodEnd: at(30) }, now);
    expect(again.convertedAt).toBeUndefined(); // conversion date is never overwritten
    expect(applyEvent(t({ status: 'SUSPENDED', pastDueSince: at(-20) }), { type: 'PAYMENT_SUCCEEDED', periodEnd: at(30) }, now)).toMatchObject({ status: 'ACTIVE', pastDueSince: null });
  });

  it('PAYMENT_FAILED starts the clock once; repeated failures never reset it', () => {
    const first = applyEvent(t({}), { type: 'PAYMENT_FAILED' }, now);
    expect(first).toMatchObject({ status: 'PAST_DUE', pastDueSince: now, changed: true });
    const repeat = applyEvent(t({ status: 'PAST_DUE', pastDueSince: at(-2) }), { type: 'PAYMENT_FAILED' }, now);
    expect(repeat.pastDueSince).toEqual(at(-2));
  });

  it('a failed FIRST payment (trial / expired / cancelled) changes nothing', () => {
    for (const status of ['TRIALING', 'EXPIRED', 'CANCELED'] as const) expect(applyEvent(t({ status }), { type: 'PAYMENT_FAILED' }, now).changed).toBe(false);
  });

  it('cancellation keeps access until the paid-through date and ignores trials', () => {
    expect(applyEvent(t({}), { type: 'CANCELLED_BY_CUSTOMER' }, now)).toMatchObject({ status: 'CANCELED', cancelAtPeriodEnd: true });
    expect(applyEvent(t({ status: 'TRIALING' }), { type: 'CANCELLED_BY_PROVIDER' }, now).changed).toBe(false);
  });

  it('trial phases: trialing, expiring, expired, converted', () => {
    const tr = (days: number, conv: Date | null = null): SubState => ({ ...base, status: 'TRIALING', trialEndsAt: at(days), convertedAt: conv });
    expect(trialPhase(tr(10), 'TRIALING', now, 3)).toBe('trialing');
    expect(trialPhase(tr(2), 'TRIALING', now, 3)).toBe('expiring');
    expect(trialPhase(tr(-1), 'EXPIRED', now, 3)).toBe('expired');
    expect(trialPhase(tr(-1, at(-1)), 'ACTIVE', now, 3)).toBe('converted');
  });
});

async function expire(ws: TestWorkspace) {
  await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() - interval '1 day' WHERE business_id = $1", [ws.businessId]);
  ws.ctx = await businessContext(ws.owner);
}

describe('expired subscription = read-only, never data loss', () => {
  it('blocks writes with 402 but keeps reads and billing available', async () => {
    const ws = await createWorkspace('Expired Co');
    const c = await createCustomer(ws.ctx, customerInput('Existing Customer'));
    await expire(ws);

    const write = await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('New') });
    expect(write.status).toBe(402);
    expect(write.body.error.code).toBe('SUBSCRIPTION_INACTIVE');

    const read = await call(listCustomersRoute, { token: ws.ctx.token });
    expect(read.status).toBe(200);
    expect(read.body.data.map((x: { id: string }) => x.id)).toContain(c.id);

    const billing = await call(billingRoute, { token: ws.ctx.token });
    expect(billing.status).toBe(200);
    expect(billing.body.data.subscription.status).toBe('EXPIRED');
    expect(billing.body.data.subscription.trial.phase).toBe('expired');
  });

  it('blocks uploads and invitations too (service layer, not just the route)', async () => {
    const ws = await createWorkspace('Expired Co 2');
    await expire(ws);
    const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    await expect(inviteMember(ws.ctx, { email: uniqueEmail(), roleId: role.id })).rejects.toMatchObject({ status: 402 });
    const png = pngOf(8);
    await expect(uploadFile(ws.ctx, { data: png, filename: 'a.png' })).rejects.toMatchObject({ status: 402 });
  });

  it('a business with no subscription row is read-only (fail closed)', async () => {
    const ws = await createWorkspace('No Sub Co');
    await ownerQuery('DELETE FROM subscriptions WHERE business_id = $1', [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    expect(ws.ctx.subscription.canWrite).toBe(false);
    expect(ws.ctx.subscription.features.size).toBe(0);
  });

  it('paying (an ACTIVE subscription) restores write access', async () => {
    const ws = await createWorkspace('Reactivated Co');
    await expire(ws);
    await ownerQuery("UPDATE subscriptions SET status = 'ACTIVE', current_period_end = now() + interval '30 days' WHERE business_id = $1", [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Back In Business') })).status).toBe(201);
  });

  it('a suspended (unpaid past grace) business is read-only too', async () => {
    const ws = await createWorkspace('Suspended Co');
    await ownerQuery("UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, current_period_end = now() - interval '30 days' WHERE business_id = $1", [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    expect(ws.ctx.subscription.status).toBe('SUSPENDED');
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Nope') })).status).toBe(402);
    expect((await call(listCustomersRoute, { token: ws.ctx.token })).status).toBe(200);
  });
});

/** Put a workspace on one of the four real plans, as a verified payment would. */
async function onPlan(name: string, planKey: 'solo' | 'team' | 'business', overrides: { members?: number } = {}) {
  const ws = await createWorkspace(name);
  await ownerQuery(
    `UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, current_period_end = now() + interval '30 days',
            plan_id = (SELECT id FROM plans WHERE key = $2), override_max_members = $3 WHERE business_id = $1`,
    [ws.businessId, planKey, overrides.members ?? null],
  );
  ws.ctx = await businessContext(ws.owner);
  return ws;
}

const techRole = async () => (await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } })).id;

describe('plan seat limits (active members; invitations reserve a seat; suspended/archived are free)', () => {
  it('SOLO: exactly 1 active user, with a clear upgrade message', async () => {
    const ws = await onPlan('Solo Co', 'solo');
    expect(ws.ctx.subscription.limits.members).toBe(1);
    const res = await call(inviteRoute, { token: ws.ctx.token, body: { email: uniqueEmail('solo'), roleId: await techRole() } });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.error.message).toMatch(/up to 1 team member/);
    expect(res.body.error.details).toMatchObject({ what: 'team members', limit: 1 });
  });

  it('TEAM: up to 10, the 11th is refused', async () => {
    const ws = await onPlan('Team Co', 'team');
    for (let i = 0; i < 9; i++) await createMemberCtx(ws, 'technician'); // owner + 9 = 10
    const over = await call(inviteRoute, { token: ws.ctx.token, body: { email: uniqueEmail('t11'), roleId: await techRole() } });
    expect(over.status).toBe(402);
    expect(over.body.error.details.limit).toBe(10);
  });

  it('BUSINESS: up to 35, the 36th is refused', async () => {
    const ws = await onPlan('Business Co', 'business');
    const role = await techRole();
    const rows = Array.from({ length: 34 }, (_, i) => i);
    for (const i of rows) {
      await ownerQuery(
        "INSERT INTO memberships (business_id, role_id, status, invited_email, invite_token_hash, invite_expires_at, updated_at) VALUES ($1, $2, 'INVITED', $3, $4, now() + interval '7 days', now())",
        [ws.businessId, role, `bulk${i}@example.test`, `hash-${ws.businessId}-${i}`],
      ); // owner + 34 reserved seats = 35
    }
    const over = await call(inviteRoute, { token: ws.ctx.token, body: { email: uniqueEmail('b36'), roleId: role } });
    expect(over.status).toBe(402);
    expect(over.body.error.details.limit).toBe(35);
  });

  it('CUSTOM: limits come from the contract overrides (36+)', async () => {
    const ws = await createWorkspace('Custom Co');
    await ownerQuery(
      `UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, current_period_end = now() + interval '1 year',
              plan_id = (SELECT id FROM plans WHERE key = 'custom'), override_max_members = 80, override_max_locations = 20 WHERE business_id = $1`,
      [ws.businessId],
    );
    ws.ctx = await businessContext(ws.owner);
    expect(ws.ctx.subscription.limits).toMatchObject({ members: 80, locations: 20 });
    expect(ws.ctx.subscription.isCustom).toBe(true);
  });

  it('suspended members do not hold a seat, but coming back needs a free one', async () => {
    const ws = await onPlan('Seat Policy Co', 'team');
    const members = [];
    for (let i = 0; i < 9; i++) members.push(await createMemberCtx(ws, 'technician')); // full: 10/10
    await changeMemberStatus(ws.ctx, members[0]!.ctx.membership.id, 'suspend'); // frees a seat
    const room = await call(inviteRoute, { token: ws.ctx.token, body: { email: uniqueEmail('free'), roleId: await techRole() } });
    expect(room.status).toBe(201); // the freed seat is now reserved by the invitation
    await expect(changeMemberStatus(ws.ctx, members[0]!.ctx.membership.id, 'reactivate')).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
  });

  it('archived memberships are free too', async () => {
    const ws = await onPlan('Archive Seat Co', 'solo');
    const { used } = { used: await prisma().membership.count({ where: { businessId: ws.businessId, status: { in: ['ACTIVE', 'INVITED'] } } }) };
    expect(used).toBe(1);
  });
});

describe('plan limits for other resources', () => {
  async function onTinyPlan(name: string) {
    await ownerQuery(
      `INSERT INTO plans (key, name, price_cents, max_members, max_locations, max_storage_mb, is_public, sort_order, status)
       VALUES ('tiny_test', 'Tiny', 100, 2, 1, 1, false, 99, 'ARCHIVED') ON CONFLICT (key) DO NOTHING`,
    );
    const ws = await createWorkspace(name);
    await ownerQuery(
      `UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, current_period_end = now() + interval '30 days',
              plan_id = (SELECT id FROM plans WHERE key = 'tiny_test') WHERE business_id = $1`,
      [ws.businessId],
    );
    ws.ctx = await businessContext(ws.owner);
    return ws;
  }

  it('storage: uploads stop at the plan quota', async () => {
    const ws = await onTinyPlan('Storage Limit Co');
    const png = (kb: number) => pngOf(kb * 1024, 0);
    await expect(uploadFile(ws.ctx, { data: png(600), filename: 'one.png' })).resolves.toBeTruthy();
    await expect(uploadFile(ws.ctx, { data: png(600), filename: 'two.png' })).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    await expect(uploadFile(ws.ctx, { data: png(100), filename: 'small.png' })).resolves.toBeTruthy();
  });

  it('limits cannot be raised by the client: the plan comes from the database', async () => {
    const ws = await onTinyPlan('Tamper Co');
    const role = await techRole();
    await inviteMember(ws.ctx, { email: uniqueEmail('t1'), roleId: role });
    const res = await call(inviteRoute, {
      token: ws.ctx.token, headers: { 'x-plan': 'business' },
      body: { email: uniqueEmail('t2'), roleId: role, maxMembers: 1000, plan: 'business' },
    });
    expect(res.status).toBe(402);
  });
});
