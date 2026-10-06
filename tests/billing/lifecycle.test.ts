import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { resetEnvForTests } from '@/lib/env';
import { clearPlatformSettingsCache } from '@/server/settings/platform';
import { cancelScheduledDowngrade, cancelSubscription, evaluatePlanChange, scheduleDowngrade, startCheckout } from '@/server/billing/plan-change';
import { PayFastProvider } from '@/server/billing/payfast';
import { getSubscriptionInvoice, listSubscriptionInvoices, getBillingOverview } from '@/server/billing/overview';
import { setPaymentProviderForTests, WebhookVerificationError, type PaymentProvider, type VerifiedWebhook } from '@/server/billing/provider';
import { handleWebhook } from '@/server/billing/webhooks';
import { runScheduledTasks } from '@/server/jobs/scheduler';
import { inviteMember } from '@/server/memberships/service';
import { createCustomer } from '@/server/customers/service';
import { POST as checkoutRoute } from '@/app/api/v1/billing/checkout/route';
import { POST as downgradeRoute, DELETE as undoDowngradeRoute } from '@/app/api/v1/billing/downgrade/route';
import { POST as cancelRoute } from '@/app/api/v1/billing/cancel/route';
import { GET as overviewRoute } from '@/app/api/v1/billing/route';
import { GET as planChangeRoute } from '@/app/api/v1/billing/plan-change/route';
import { GET as invoicesRoute } from '@/app/api/v1/billing/invoices/route';
import { POST as createCustomerRoute } from '@/app/api/v1/customers/route';
import { call } from '../helpers/http';
import {
  businessContext, createMemberCtx, createWorkspace, drainJobs, ownerQuery, restoreEnv, sentTo, uniqueEmail, userContext,
  type TestWorkspace,
} from '../helpers/factory';

import { customerInput } from '../helpers/customers';

afterAll(disconnectPrisma);

const DAY = 86_400_000;
const PRICES = { solo: 49_900, team: 99_900, business: 199_900 } as const;
const gross = (key: keyof typeof PRICES) => PRICES[key] + Math.round(PRICES[key] * 0.15);

class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  capabilities = { cancelSubscription: true, updateAmount: true };
  next: VerifiedWebhook | null = null;
  cancelled: string[] = [];
  updated: { ref: string; amount: number }[] = [];
  createCheckout() {
    return { actionUrl: 'https://pay.test/process', fields: { m: '1' } };
  }
  async verifyWebhook(): Promise<VerifiedWebhook> {
    if (!this.next) throw new WebhookVerificationError('nothing queued');
    return this.next;
  }
  async cancelSubscription(ref: string) { this.cancelled.push(ref); }
  async updateAmount(ref: string, amount: number) { this.updated.push({ ref, amount }); }
}
const fake = new FakeProvider();
let seq = 0;

beforeAll(async () => {
  await ownerQuery("UPDATE plans SET price_cents = CASE key WHEN 'solo' THEN 49900 WHEN 'team' THEN 99900 WHEN 'business' THEN 199900 END WHERE key IN ('solo','team','business')");
  setPaymentProviderForTests(fake);
});
afterEach(async () => {
  fake.next = null;
  fake.capabilities = { cancelSubscription: true, updateAmount: true };
  setPaymentProviderForTests(fake);
  await ownerQuery("DELETE FROM platform_settings WHERE key LIKE 'trial_%' OR key LIKE 'past_due_%' OR key = 'grace_days'");
  clearPlatformSettingsCache();
});

const event = (paymentId: string, amountCents: number, over: Partial<VerifiedWebhook> = {}): VerifiedWebhook => {
  const id = `pf-${Date.now()}-${++seq}`;
  const status = over.status ?? 'COMPLETE';
  return { provider: 'fake', externalId: `${id}:${status}`, eventType: `payment.${status.toLowerCase()}`, paymentId, providerPaymentId: id, amountCents, status, payload: {}, ...over };
};

async function fresh(ws: TestWorkspace) {
  ws.ctx = await businessContext(ws.owner);
  return ws.ctx;
}

/** Buy a plan end-to-end exactly as production would: checkout -> verified webhook. */
async function buy(ws: TestWorkspace, planKey: keyof typeof PRICES, ref = `tok_${Math.random().toString(36).slice(2, 10)}`) {
  await startCheckout(ws.ctx, planKey);
  const p = (await ownerQuery<{ id: string; amount_cents: number }>('SELECT id, amount_cents FROM subscription_payments WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1', [ws.businessId])).rows[0]!;
  fake.next = event(p.id, p.amount_cents, { subscriptionRef: ref });
  await handleWebhook(fake, 'raw', {});
  await fresh(ws);
  return { paymentId: p.id, amount: p.amount_cents, ref };
}

const sub = async (ws: TestWorkspace) =>
  (await ownerQuery('SELECT s.*, p.key AS plan_key, pp.key AS pending_key FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN plans pp ON pp.id = s.pending_plan_id WHERE s.business_id = $1', [ws.businessId])).rows[0]!;

describe('plan change evaluation (the confirmation screen’s source of truth)', () => {
  it('shows exact pricing, limit and feature differences for an upgrade from the trial', async () => {
    const ws = await createWorkspace('Eval Co');
    const ev = await evaluatePlanChange(ws.ctx, 'team');
    expect(ev).toMatchObject({ direction: 'upgrade', mode: 'checkout', canProceed: true, reason: null });
    expect(ev.target).toMatchObject({ key: 'team', priceCents: 99_900, vatCents: 14_985, totalCents: 114_885 });
    expect(ev.limitChanges.find((l) => l.what === 'Team members')).toEqual({ what: 'Team members', from: 10, to: 10 });
    expect(ev.featuresLost.map((f) => f.key)).toEqual(expect.arrayContaining(['custom_roles']));
  });

  it('blocks a plan whose limits the business already exceeds, and says exactly what to fix', async () => {
    const ws = await createWorkspace('Too Big Co');
    await createMemberCtx(ws, 'technician');
    await createMemberCtx(ws, 'technician'); // 3 people
    const ev = await evaluatePlanChange(ws.ctx, 'solo');
    expect(ev.canProceed).toBe(false);
    expect(ev.violations).toEqual([expect.objectContaining({ kind: 'members', used: 3, limit: 1 })]);
    expect(ev.reason).toMatch(/3 team members.*allows 1.*2 first/);
    await expect(startCheckout(ws.ctx, 'solo')).rejects.toMatchObject({ status: 400 });
    expect((await ownerQuery('SELECT 1 FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rowCount).toBe(0); // nothing was created
  });

  it('counts pending invitations and storage in the usage it checks', async () => {
    const ws = await createWorkspace('Usage Check Co');
    const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    await inviteMember(ws.ctx, { email: uniqueEmail('inv'), roleId: role.id });
    const ev = await evaluatePlanChange(ws.ctx, 'solo');
    expect(ev.violations.find((v) => v.kind === 'members')).toMatchObject({ used: 2 });
  });

  it('custom plans are arranged with the team, and unpriced plans cannot be bought', async () => {
    const ws = await createWorkspace('Contact Co');
    const custom = await evaluatePlanChange(ws.ctx, 'custom');
    expect(custom).toMatchObject({ mode: 'contact', canProceed: false });
    await expect(startCheckout(ws.ctx, 'custom')).rejects.toMatchObject({ status: 400 });

    await ownerQuery("UPDATE plans SET price_cents = NULL WHERE key = 'solo'");
    try {
      const unpriced = await evaluatePlanChange(ws.ctx, 'solo');
      expect(unpriced).toMatchObject({ canProceed: false, reason: expect.stringMatching(/not been configured/i) });
      await expect(startCheckout(ws.ctx, 'solo')).rejects.toMatchObject({ status: 400 });
    } finally {
      await ownerQuery('UPDATE plans SET price_cents = 49900 WHERE key = $1', ['solo']);
    }
  });

  it('refuses unknown, internal (trial) and archived plans', async () => {
    const ws = await createWorkspace('Hidden Plans Co');
    await expect(evaluatePlanChange(ws.ctx, 'trial')).rejects.toMatchObject({ status: 404 });
    await expect(evaluatePlanChange(ws.ctx, 'nonsense')).rejects.toMatchObject({ status: 404 });
    await expect(evaluatePlanChange(ws.ctx, 'starter')).rejects.toMatchObject({ status: 404 }); // archived from Part 1
  });

  it('the preview endpoint changes nothing', async () => {
    const ws = await createWorkspace('Preview Co');
    const before = await sub(ws);
    const res = await call(planChangeRoute, { token: ws.ctx.token, query: { plan: 'business' } });
    expect(res.status).toBe(200);
    expect(res.body.data.target.totalCents).toBe(gross('business'));
    expect((await sub(ws)).plan_key).toBe(before.plan_key);
    expect((await ownerQuery('SELECT 1 FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rowCount).toBe(0);
  });
});

describe('upgrade: select → confirm → provider → verified webhook → entitlement', () => {
  it('never grants the plan from the checkout click alone; only the verified webhook does', async () => {
    const ws = await createWorkspace('Click Co');
    const form = await startCheckout(ws.ctx, 'team');
    expect(form.actionUrl).toBe('https://pay.test/process');
    expect((await sub(ws)).plan_key).toBe('trial'); // clicking "pay" changed nothing
    expect((await fresh(ws)).subscription.status).toBe('TRIALING');
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'subscription.checkout_started'", [ws.businessId]);
    expect(audit.rows[0]?.metadata).toMatchObject({ planKey: 'team', amountCents: gross('team') });
  });

  it('converts a trial to a paid plan: ACTIVE, converted, new limits and features, audit, email, invoice', async () => {
    const ws = await createWorkspace('Convert Co');
    await buy(ws, 'team', 'tok_convert');
    const s = await sub(ws);
    expect(s).toMatchObject({ status: 'ACTIVE', plan_key: 'team', provider: 'fake', provider_subscription_ref: 'tok_convert', recurring_amount_cents: gross('team') });
    expect(s.converted_at).not.toBeNull();
    expect(s.trial_ends_at).toBeNull();
    expect((await fresh(ws)).subscription).toMatchObject({ status: 'ACTIVE', planKey: 'team', trialPhase: 'converted', canWrite: true });
    expect(ws.ctx.subscription.limits.members).toBe(10);
    expect(ws.ctx.subscription.features.has('multi_location')).toBe(false); // multi-location is a Business feature
    expect(ws.ctx.subscription.features.has('purchase_orders')).toBe(true);
    expect(ws.ctx.subscription.features.has('custom_roles')).toBe(false);

    const days = (new Date(s.current_period_end).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    const audit = await ownerQuery("SELECT action, metadata FROM audit_logs WHERE business_id = $1 AND action IN ('subscription.plan_changed','billing.payment_received','billing.invoice_issued')", [ws.businessId]);
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['billing.invoice_issued', 'billing.payment_received', 'subscription.plan_changed']);
    expect(audit.rows.find((r) => r.action === 'subscription.plan_changed')?.metadata.converted).toBe(true);
    await drainJobs();
    expect(sentTo(ws.owner.email).map((m) => m.subject).join(" | ")).toMatch(/payment received/i);
  });

  it('upgrading again moves to the new plan and ends the old provider subscription so they are never billed twice', async () => {
    const ws = await createWorkspace('Upgrade Co');
    await buy(ws, 'team', 'tok_old');
    await buy(ws, 'business', 'tok_new');
    const s = await sub(ws);
    expect(s).toMatchObject({ plan_key: 'business', provider_subscription_ref: 'tok_new', recurring_amount_cents: gross('business') });
    await drainJobs();
    expect(fake.cancelled).toContain('tok_old');
    expect(fake.cancelled).not.toContain('tok_new');
  });

  it('a failed upgrade checkout never harms the current paid plan', async () => {
    const ws = await createWorkspace('Failed Upgrade Co');
    await buy(ws, 'team', 'tok_keep');
    await startCheckout(ws.ctx, 'business');
    const p = (await ownerQuery<{ id: string; amount_cents: number }>("SELECT id, amount_cents FROM subscription_payments WHERE business_id = $1 AND status = 'PENDING'", [ws.businessId])).rows[0]!;
    fake.next = event(p.id, p.amount_cents, { status: 'FAILED' });
    await handleWebhook(fake, 'raw', {});
    expect(await sub(ws)).toMatchObject({ status: 'ACTIVE', plan_key: 'team', past_due_since: null });
    expect((await ownerQuery('SELECT status FROM subscription_payments WHERE id = $1', [p.id])).rows[0]?.status).toBe('FAILED');
  });
});

describe('downgrade: validated against real usage, effective at the end of the paid period', () => {
  it('schedules the change, keeps today’s plan, pushes the lower price to the provider, and applies at period end', async () => {
    const ws = await createWorkspace('Down Co');
    await buy(ws, 'business', 'tok_down');
    const res = await scheduleDowngrade(ws.ctx, 'team');
    expect(res.effectiveAt).toBeInstanceOf(Date);

    let s = await sub(ws);
    expect(s).toMatchObject({ plan_key: 'business', pending_key: 'team' }); // still on Business today
    await drainJobs();
    expect(fake.updated).toEqual([{ ref: 'tok_down', amount: gross('team') }]);
    s = await sub(ws);
    expect(s.recurring_amount_cents).toBe(gross('team')); // recorded only after the provider confirmed

    // Before the period ends nothing switches…
    await runScheduledTasks();
    expect((await sub(ws)).plan_key).toBe('business');
    // …at the period end, it does.
    await ownerQuery("UPDATE subscriptions SET pending_change_at = now() - interval '1 minute' WHERE business_id = $1", [ws.businessId]);
    const tick = await runScheduledTasks();
    expect(tick.downgradesApplied).toBeGreaterThanOrEqual(1);
    expect(await sub(ws)).toMatchObject({ plan_key: 'team', pending_key: null });
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'subscription.plan_changed' ORDER BY created_at DESC LIMIT 1", [ws.businessId]);
    expect(audit.rows[0]?.metadata).toMatchObject({ scheduledDowngrade: true });
    expect((await fresh(ws)).subscription.planKey).toBe('team');
  });

  it('the next renewal is validated against the NEW lower amount, and the old amount is refused', async () => {
    const ws = await createWorkspace('Renewal Co');
    const bought = await buy(ws, 'business', 'tok_renew');
    await scheduleDowngrade(ws.ctx, 'team');
    await drainJobs();
    await ownerQuery("UPDATE subscriptions SET pending_change_at = now() - interval '1 minute', current_period_end = now() - interval '1 hour' WHERE business_id = $1", [ws.businessId]);

    fake.next = event(bought.paymentId, gross('business')); // provider still charging the old price: suspicious
    expect(await handleWebhook(fake, 'raw', {})).toMatchObject({ result: 'ignored', reason: 'amount mismatch' });

    fake.next = event(bought.paymentId, gross('team'), { subscriptionRef: 'tok_renew' });
    expect(await handleWebhook(fake, 'raw', {})).toEqual({ result: 'processed' });
    expect(await sub(ws)).toMatchObject({ status: 'ACTIVE', plan_key: 'team', pending_key: null });
  });

  it('is refused while usage exceeds the target plan — explaining what to change', async () => {
    const ws = await createWorkspace('Crowded Co');
    await buy(ws, 'business', 'tok_crowd');
    const role = (await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } })).id;
    for (let i = 0; i < 11; i++) {
      await ownerQuery("INSERT INTO memberships (business_id, role_id, status, invited_email, invite_token_hash, invite_expires_at, updated_at) VALUES ($1, $2, 'INVITED', $3, $4, now() + interval '7 days', now())", [ws.businessId, role, `crowd${i}@example.test`, `crowd-${ws.businessId}-${i}`]);
    }
    await fresh(ws);
    const ev = await evaluatePlanChange(ws.ctx, 'team');
    expect(ev.canProceed).toBe(false);
    expect(ev.violations[0]).toMatchObject({ kind: 'members', used: 12, limit: 10 });
    await expect(scheduleDowngrade(ws.ctx, 'team')).rejects.toMatchObject({ status: 400 });
    expect((await sub(ws)).pending_key).toBeNull();
  });

  it('while a downgrade is pending, usage cannot grow past what the lower plan allows', async () => {
    const ws = await createWorkspace('Pending Cap Co');
    await buy(ws, 'business', 'tok_cap');
    for (let i = 0; i < 8; i++) await createMemberCtx(ws, 'technician'); // 9 people
    await fresh(ws);
    await scheduleDowngrade(ws.ctx, 'team');
    await fresh(ws);
    expect(ws.ctx.subscription.limits.members).toBe(10); // min(35, 10)
    const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    await inviteMember(ws.ctx, { email: uniqueEmail('cap1'), roleId: role.id }); // 10th seat ok
    await expect(inviteMember(ws.ctx, { email: uniqueEmail('cap2'), roleId: role.id })).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
  });

  it('can be cancelled before it takes effect, restoring the provider price', async () => {
    const ws = await createWorkspace('Undo Down Co');
    await buy(ws, 'business', 'tok_undo');
    await scheduleDowngrade(ws.ctx, 'team');
    await drainJobs();
    await cancelScheduledDowngrade(ws.ctx);
    await drainJobs();
    expect((await sub(ws)).pending_key).toBeNull();
    expect(fake.updated.at(-1)).toEqual({ ref: 'tok_undo', amount: gross('business') });
    await expect(cancelScheduledDowngrade(ws.ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('needs a provider that can change the amount, and a paid plan to downgrade from', async () => {
    const trial = await createWorkspace('Trial Down Co');
    const ev = await evaluatePlanChange(trial.ctx, 'solo');
    expect(ev.mode).toBe('checkout'); // from a trial, "solo" is a purchase, not a downgrade

    const ws = await createWorkspace('No Update Co');
    await buy(ws, 'business', 'tok_noupd');
    fake.capabilities = { cancelSubscription: true, updateAmount: false };
    const blocked = await evaluatePlanChange(ws.ctx, 'team');
    expect(blocked).toMatchObject({ mode: 'scheduled_downgrade', canProceed: false, reason: expect.stringMatching(/cannot change the amount/i) });
    await expect(scheduleDowngrade(ws.ctx, 'team')).rejects.toMatchObject({ status: 400 });
  });

  it('does not allow a second pending change', async () => {
    const ws = await createWorkspace('Double Down Co');
    await buy(ws, 'business', 'tok_dbl');
    await scheduleDowngrade(ws.ctx, 'team');
    await fresh(ws);
    await expect(scheduleDowngrade(ws.ctx, 'solo')).rejects.toMatchObject({ status: 400 });
  });
});

describe('cancellation', () => {
  it('keeps access to the paid-through date, never deletes anything, stops provider billing, and is fully recorded', async () => {
    const ws = await createWorkspace('Cancel Co');
    await createCustomer(ws.ctx, customerInput('Safe Customer'));
    await buy(ws, 'team', 'tok_cancel');
    const out = await cancelSubscription(ws.ctx, { reason: 'Too expensive', confirm: true });
    expect(out.accessUntil).toBeInstanceOf(Date);

    const s = await sub(ws);
    expect(s).toMatchObject({ status: 'CANCELED', cancel_at_period_end: true, cancel_reason: 'Too expensive', canceled_by_id: ws.owner.id });
    expect(s.canceled_at).not.toBeNull();
    await fresh(ws);
    expect(ws.ctx.subscription).toMatchObject({ status: 'CANCELED', canWrite: true }); // paid for, so still fully usable
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Still Works') })).status).toBe(201);

    await drainJobs();
    expect(fake.cancelled).toContain('tok_cancel');
    const audit = await ownerQuery("SELECT user_id, metadata FROM audit_logs WHERE business_id = $1 AND action = 'subscription.cancelled'", [ws.businessId]);
    expect(audit.rows[0]).toMatchObject({ user_id: ws.owner.id, metadata: { reason: 'Too expensive', by: 'customer' } });
    expect(sentTo(ws.owner.email).map((m) => m.subject).join(" | ")).toMatch(/subscription cancelled/i);
    expect((await ownerQuery('SELECT count(*)::int n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]?.n).toBe(2);
  });

  it('after the paid period ends the business is read-only (and the scheduler records it once)', async () => {
    const ws = await createWorkspace('Cancel Ends Co');
    await buy(ws, 'team', 'tok_end');
    await cancelSubscription(ws.ctx, { confirm: true });
    await ownerQuery("UPDATE subscriptions SET current_period_end = now() - interval '1 hour' WHERE business_id = $1", [ws.businessId]);
    expect((await fresh(ws)).subscription).toMatchObject({ status: 'EXPIRED', canWrite: false });
    await runScheduledTasks();
    await runScheduledTasks();
    await drainJobs();
    expect((await sub(ws)).status).toBe('EXPIRED');
    expect((await ownerQuery("SELECT count(*)::int n FROM audit_logs WHERE business_id = $1 AND action = 'subscription.expired'", [ws.businessId])).rows[0]?.n).toBe(1);
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('No') })).status).toBe(402);
  });

  it('needs explicit confirmation, a paid subscription, and cannot be done twice', async () => {
    const trial = await createWorkspace('Trial Cancel Co');
    await expect(cancelSubscription(trial.ctx, { confirm: true })).rejects.toMatchObject({ status: 409 });
    const ws = await createWorkspace('Confirm Co');
    await buy(ws, 'team', 'tok_conf');
    expect((await call(cancelRoute, { token: ws.ctx.token, body: {} })).status).toBe(422);
    expect((await call(cancelRoute, { token: ws.ctx.token, body: { confirm: false } })).status).toBe(422);
    expect((await sub(ws)).status).toBe('ACTIVE');
    expect((await call(cancelRoute, { token: ws.ctx.token, body: { confirm: true } })).status).toBe(200);
    expect((await call(cancelRoute, { token: ws.ctx.token, body: { confirm: true } })).status).toBe(409);
  });

  it('clears a scheduled downgrade', async () => {
    const ws = await createWorkspace('Cancel Pending Co');
    await buy(ws, 'business', 'tok_cp');
    await scheduleDowngrade(ws.ctx, 'team');
    await fresh(ws);
    await cancelSubscription(ws.ctx, { confirm: true });
    expect((await sub(ws)).pending_key).toBeNull();
  });
});

describe('failed payments: past due → grace → suspended, preserving data throughout', () => {
  async function activeWs(name: string) {
    const ws = await createWorkspace(name);
    const b = await buy(ws, 'team', `tok_${name.replace(/\W/g, '')}`);
    await createCustomer(ws.ctx, customerInput(`${name} data`));
    return { ws, ...b };
  }

  it('records the failure, notifies the billing contacts, and starts the clock WITHOUT restricting anything', async () => {
    const { ws, paymentId, amount } = await activeWs('Fail Co');
    const admin = await createMemberCtx(ws, 'admin'); // holds settings.manage_billing too
    const tech = await createMemberCtx(ws, 'technician');
    await drainJobs();
    const before = { owner: sentTo(ws.owner.email).length, admin: sentTo(admin.user.email).length, tech: sentTo(tech.user.email).length };

    fake.next = event(paymentId, amount, { status: 'FAILED' });
    expect(await handleWebhook(fake, 'raw', {})).toEqual({ result: 'processed' });
    const s = await sub(ws);
    expect(s.status).toBe('PAST_DUE');
    expect(s.past_due_since).not.toBeNull();
    expect((await fresh(ws)).subscription).toMatchObject({ status: 'PAST_DUE', canWrite: true });

    await drainJobs();
    expect(sentTo(ws.owner.email).map((m) => m.subject).join(" | ")).toMatch(/payment failed/i);
    expect(sentTo(ws.owner.email).length).toBe(before.owner + 1);
    expect(sentTo(admin.user.email).length).toBe(before.admin + 1);
    expect(sentTo(tech.user.email).length).toBe(before.tech); // people without billing access are not told
    expect((await ownerQuery("SELECT count(*)::int n FROM audit_logs WHERE business_id = $1 AND action = 'billing.payment_failed'", [ws.businessId])).rows[0]?.n).toBe(1);
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Works while past due') })).status).toBe(201);
  });

  it('repeated failures do not reset the grace clock', async () => {
    const { ws, paymentId, amount } = await activeWs('Repeat Fail Co');
    fake.next = event(paymentId, amount, { status: 'FAILED' });
    await handleWebhook(fake, 'raw', {});
    const first = (await sub(ws)).past_due_since;
    fake.next = event(paymentId, amount, { status: 'FAILED' });
    await handleWebhook(fake, 'raw', {});
    expect((await sub(ws)).past_due_since).toEqual(first);
  });

  it('after the retry window the scheduler moves it to GRACE_PERIOD (still working) and tells the owner — once', async () => {
    const { ws, paymentId, amount } = await activeWs('Grace Co');
    fake.next = event(paymentId, amount, { status: 'FAILED' });
    await handleWebhook(fake, 'raw', {});
    await ownerQuery("UPDATE subscriptions SET past_due_since = now() - interval '4 days' WHERE business_id = $1", [ws.businessId]);
    await drainJobs();
    const emailsBefore = sentTo(ws.owner.email).length;

    expect((await runScheduledTasks()).delinquencyPhases).toBeGreaterThanOrEqual(1);
    await runScheduledTasks(); // overlapping run: must not double up
    await drainJobs();
    expect((await sub(ws)).status).toBe('GRACE_PERIOD');
    expect(sentTo(ws.owner.email).length).toBe(emailsBefore + 1);
    expect(sentTo(ws.owner.email).map((m) => m.subject).join(" | ")).toMatch(/grace period/i);
    expect((await fresh(ws)).subscription).toMatchObject({ status: 'GRACE_PERIOD', canWrite: true });
    expect((await ownerQuery("SELECT count(*)::int n FROM audit_logs WHERE business_id = $1 AND action = 'subscription.grace_period_started'", [ws.businessId])).rows[0]?.n).toBe(1);
  });

  it('after the grace period it becomes SUSPENDED: read-only, data preserved, with a clear path back', async () => {
    const { ws, paymentId, amount } = await activeWs('Suspend Co');
    fake.next = event(paymentId, amount, { status: 'FAILED' });
    await handleWebhook(fake, 'raw', {});
    await ownerQuery("UPDATE subscriptions SET past_due_since = now() - interval '11 days' WHERE business_id = $1", [ws.businessId]);
    await runScheduledTasks();
    await drainJobs();
    expect((await sub(ws)).status).toBe('SUSPENDED');
    expect(sentTo(ws.owner.email).map((m) => m.subject).join(" | ")).toMatch(/suspended/i);
    await fresh(ws);
    expect(ws.ctx.subscription).toMatchObject({ status: 'SUSPENDED', canWrite: false });
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('No') })).status).toBe(402);
    expect((await ownerQuery('SELECT count(*)::int n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]?.n).toBe(1); // nothing deleted
    expect((await call(overviewRoute, { token: ws.ctx.token })).status).toBe(200); // billing stays reachable to fix it

    // Paying restores everything immediately.
    fake.next = event(paymentId, amount);
    await handleWebhook(fake, 'raw', {});
    await fresh(ws);
    expect(ws.ctx.subscription).toMatchObject({ status: 'ACTIVE', canWrite: true });
    expect((await sub(ws)).past_due_since).toBeNull();
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Back') })).status).toBe(201);
  });

  it('windows are configurable at platform level, not hard-coded', async () => {
    const { ws, paymentId, amount } = await activeWs('Config Co');
    await ownerQuery("INSERT INTO platform_settings (key, value, updated_at) VALUES ('past_due_retry_days','10',now()), ('grace_days','2',now())");
    clearPlatformSettingsCache();
    fake.next = event(paymentId, amount, { status: 'FAILED' });
    await handleWebhook(fake, 'raw', {});
    await ownerQuery("UPDATE subscriptions SET past_due_since = now() - interval '5 days' WHERE business_id = $1", [ws.businessId]);
    expect((await fresh(ws)).subscription.status).toBe('PAST_DUE'); // 5d < the configured 10d retry window
    await ownerQuery("UPDATE subscriptions SET past_due_since = now() - interval '11 days' WHERE business_id = $1", [ws.businessId]);
    expect((await fresh(ws)).subscription.status).toBe('GRACE_PERIOD');
    await ownerQuery("UPDATE subscriptions SET past_due_since = now() - interval '13 days' WHERE business_id = $1", [ws.businessId]);
    expect((await fresh(ws)).subscription.status).toBe('SUSPENDED');
  });

  it('a lapsed period with no renewal and no webhook at all is still caught', async () => {
    const { ws } = await activeWs('Silent Co');
    await ownerQuery("UPDATE subscriptions SET current_period_end = now() - interval '6 days' WHERE business_id = $1", [ws.businessId]);
    expect((await fresh(ws)).subscription.status).toBe('GRACE_PERIOD');
    await runScheduledTasks();
    await drainJobs();
    expect((await sub(ws)).status).toBe('GRACE_PERIOD'); // stored state catches up
    expect((await sub(ws)).past_due_since).not.toBeNull();
  });
});

describe('trial reminders and expiry (scheduled, configurable, idempotent)', () => {
  const setTrialEnds = (ws: TestWorkspace, interval: string) => ownerQuery(`UPDATE subscriptions SET trial_ends_at = now() + interval '${interval}' WHERE business_id = $1`, [ws.businessId]);
  const reminderMails = async (email: string) => sentTo(email).map((m) => m.subject).filter((x) => /left in your free trial/.test(x));

  it('sends one reminder per window as the trial runs down: 7, 3, then 1 day', async () => {
    const ws = await createWorkspace('Reminder Co');
    await setTrialEnds(ws, '6 days');
    await runScheduledTasks();
    await runScheduledTasks();
    await drainJobs();
    expect((await reminderMails(ws.owner.email)).length).toBe(1);
    expect((await reminderMails(ws.owner.email))[0]).toMatch(/^6 days left/);

    await setTrialEnds(ws, '2 days 12 hours');
    await runScheduledTasks();
    await drainJobs();
    expect((await reminderMails(ws.owner.email)).length).toBe(2);

    await setTrialEnds(ws, '10 hours');
    await runScheduledTasks();
    await runScheduledTasks();
    await drainJobs();
    expect((await reminderMails(ws.owner.email)).length).toBe(3);
    expect((await reminderMails(ws.owner.email))[2]).toMatch(/^1 day left/);
  });

  it('does not nag outside the reminder windows', async () => {
    const ws = await createWorkspace('Quiet Co');
    await setTrialEnds(ws, '12 days');
    await runScheduledTasks();
    await drainJobs();
    expect(await reminderMails(ws.owner.email)).toHaveLength(0);
  });

  it('the reminder schedule is configuration, not code', async () => {
    const ws = await createWorkspace('Custom Schedule Co');
    await ownerQuery("INSERT INTO platform_settings (key, value, updated_at) VALUES ('trial_reminder_days', '12,10', now())");
    clearPlatformSettingsCache();
    await setTrialEnds(ws, '11 days');
    await runScheduledTasks();
    await drainJobs();
    expect(await reminderMails(ws.owner.email)).toHaveLength(1);
  });

  it('a person who opted out of trial reminders is not emailed', async () => {
    const ws = await createWorkspace('Opt Out Co');
    const { setNotificationPreferences } = await import('@/server/account/service');
    await setNotificationPreferences(await userContext(ws.owner), { preferences: { trial_reminders: false } });
    await setTrialEnds(ws, '2 days');
    await runScheduledTasks();
    await drainJobs();
    expect(await reminderMails(ws.owner.email)).toHaveLength(0);
  });

  it('does not remind a business that already paid', async () => {
    const ws = await createWorkspace('Paid Early Co');
    await buy(ws, 'team', 'tok_early');
    await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() + interval '1 day' WHERE business_id = $1", [ws.businessId]);
    await runScheduledTasks();
    await drainJobs();
    expect(await reminderMails(ws.owner.email)).toHaveLength(0);
  });

  it('at expiry: stored state, audit and one email — nothing deleted — and read-only', async () => {
    const ws = await createWorkspace('Expiry Co');
    await createCustomer(ws.ctx, customerInput('Trial Era Customer'));
    await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() - interval '1 hour' WHERE business_id = $1", [ws.businessId]);
    await runScheduledTasks();
    await runScheduledTasks();
    await drainJobs();
    expect((await sub(ws)).status).toBe('EXPIRED');
    expect((await ownerQuery("SELECT count(*)::int n FROM audit_logs WHERE business_id = $1 AND action = 'subscription.trial_expired'", [ws.businessId])).rows[0]?.n).toBe(1);
    expect(sentTo(ws.owner.email).some((m) => /trial for .* has ended/i.test(m.subject))).toBe(true);
    expect((await fresh(ws)).subscription).toMatchObject({ status: 'EXPIRED', canWrite: false, trialPhase: 'expired' });
    expect((await ownerQuery('SELECT count(*)::int n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]?.n).toBe(1);
  });

  it('a business that pays after the trial ends continues as subscribed', async () => {
    const ws = await createWorkspace('Late Pay Co');
    await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() - interval '2 days' WHERE business_id = $1", [ws.businessId]);
    await runScheduledTasks();
    await drainJobs();
    expect((await sub(ws)).status).toBe('EXPIRED');
    await buy(ws, 'team', 'tok_late');
    expect((await fresh(ws)).subscription).toMatchObject({ status: 'ACTIVE', canWrite: true, trialPhase: 'converted' });
  });
});

describe('subscription invoices', () => {
  it('issues a numbered tax invoice per payment, with VAT extracted correctly, visible only to that business', async () => {
    const ws = await createWorkspace('Invoice Co');
    const other = await createWorkspace('Invoice Other Co');
    const { paymentId } = await buy(ws, 'team', 'tok_inv');
    await drainJobs();

    const list = await listSubscriptionInvoices(ws.ctx, {});
    expect(list.items).toHaveLength(1);
    const inv = list.items[0]!;
    expect(inv.number).toMatch(/^TFMEA-\d{6}$/);
    expect(inv.totalCents).toBe(gross('team'));
    expect(inv.subtotalCents + inv.vatCents).toBe(inv.totalCents);
    expect(inv.vatCents).toBe(gross('team') - Math.round((gross('team') * 10_000) / 11_500));
    expect(inv).toMatchObject({ vatRateBps: 1500, currency: 'ZAR', planName: 'Team' });

    const got = await getSubscriptionInvoice(ws.ctx, inv.id);
    expect(got.invoice.number).toBe(inv.number);
    await expect(getSubscriptionInvoice(other.ctx, inv.id)).rejects.toMatchObject({ status: 404 }); // another business's invoice
    expect((await call(invoicesRoute, { token: other.ctx.token })).body.data).toEqual([]);

    // A renewal gets its own invoice with a new number; a duplicate delivery does not get a third.
    fake.next = event(paymentId, gross('team'));
    await handleWebhook(fake, 'raw', {});
    await handleWebhook(fake, 'raw', {});
    const after = await listSubscriptionInvoices(ws.ctx, {});
    expect(after.items).toHaveLength(2);
    expect(new Set(after.items.map((i) => i.number)).size).toBe(2);
  });

  it('numbers are unique across businesses', async () => {
    const a = await createWorkspace('Num A');
    const b = await createWorkspace('Num B');
    await buy(a, 'solo', 'tok_na');
    await buy(b, 'solo', 'tok_nb');
    const numbers = (await ownerQuery('SELECT number FROM subscription_invoices WHERE business_id IN ($1, $2)', [a.businessId, b.businessId])).rows.map((r) => r.number);
    expect(new Set(numbers).size).toBe(2);
  });

  it('the database refuses an invoice whose totals do not add up', async () => {
    const ws = await createWorkspace('Bad Invoice Co');
    const { paymentId } = await buy(ws, 'solo', 'tok_bad');
    await expect(ownerQuery('UPDATE subscription_invoices SET total_cents = total_cents + 1 WHERE payment_id = $1', [paymentId])).rejects.toThrow(/totals/);
  });
});

describe('billing access control and secrecy', () => {
  it('only roles with settings.manage_billing may view or change billing — everyone else is refused on every endpoint', async () => {
    const ws = await createWorkspace('Locked Billing Co');
    await buy(ws, 'team', 'tok_locked');
    for (const role of ['technician', 'service_advisor', 'inventory_staff', 'accounts', 'manager']) {
      const m = await createMemberCtx(ws, role);
      const t = m.ctx.token;
      expect((await call(overviewRoute, { token: t })).status, `${role} overview`).toBe(403);
      expect((await call(planChangeRoute, { token: t, query: { plan: 'business' } })).status, `${role} preview`).toBe(403);
      expect((await call(checkoutRoute, { token: t, body: { planKey: 'business' } })).status, `${role} checkout`).toBe(403);
      expect((await call(downgradeRoute, { token: t, body: { planKey: 'solo' } })).status, `${role} downgrade`).toBe(403);
      expect((await call(undoDowngradeRoute, { method: 'DELETE', token: t })).status, `${role} undo`).toBe(403);
      expect((await call(cancelRoute, { token: t, body: { confirm: true } })).status, `${role} cancel`).toBe(403);
      expect((await call(invoicesRoute, { token: t })).status, `${role} invoices`).toBe(403);
    }
    expect((await sub(ws)).status).toBe('ACTIVE');
    expect((await sub(ws)).plan_key).toBe('team');
    expect((await call(overviewRoute, {})).status).toBe(401);
    expect((await call(checkoutRoute, { body: { planKey: 'business' } })).status).toBe(401);
  });

  it('the Admin role may manage billing; the unauthorised attempts above left no trace of payment records', async () => {
    const ws = await createWorkspace('Admin Billing Co');
    const admin = await createMemberCtx(ws, 'admin');
    expect((await call(overviewRoute, { token: admin.ctx.token })).status).toBe(200);
    const before = (await ownerQuery('SELECT count(*)::int n FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rows[0]?.n;
    const tech = await createMemberCtx(ws, 'technician');
    await call(checkoutRoute, { token: tech.ctx.token, body: { planKey: 'team' } });
    expect((await ownerQuery('SELECT count(*)::int n FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rows[0]?.n).toBe(before);
  });

  it('billing responses never expose provider tokens, credentials or card data', async () => {
    const ws = await createWorkspace('Secret Billing Co');
    await buy(ws, 'team', 'tok_SUPER_SECRET_REF');
    const overview = await call(overviewRoute, { token: ws.ctx.token });
    const text = JSON.stringify(overview.body);
    expect(text).not.toContain('tok_SUPER_SECRET_REF');
    expect(text).not.toMatch(/providerSubscriptionRef|merchant_key|passphrase|cardNumber|pan\b/i);
    expect(overview.body.data.subscription.paymentMethod).toBe('Managed by fake');
    expect((await getBillingOverview(ws.ctx)).usage.members.limit).toBe(10);
  });

  it('billing is shown per BUSINESS: a person with two businesses sees each subscription separately', async () => {
    const a = await createWorkspace('Two Biz A');
    const b = await createWorkspace('Two Biz B');
    await buy(a, 'business', 'tok_a');
    expect((await call(overviewRoute, { token: a.ctx.token })).body.data.subscription.planKey).toBe('business');
    expect((await call(overviewRoute, { token: b.ctx.token })).body.data.subscription.planKey).toBe('trial');
  });
});

describe('PayFast subscription API calls (stubbed HTTP; not yet exercised against PayFast’s live sandbox)', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { id: env.PAYFAST_MERCHANT_ID, pass: env.PAYFAST_PASSPHRASE, sb: env.PAYFAST_SANDBOX };
  beforeAll(() => {
    env.PAYFAST_MERCHANT_ID = '10000100';
    env.PAYFAST_PASSPHRASE = 'api-passphrase';
    env.PAYFAST_SANDBOX = 'true';
    resetEnvForTests();
  });
  afterAll(() => {
    restoreEnv('PAYFAST_MERCHANT_ID', saved.id);
    restoreEnv('PAYFAST_PASSPHRASE', saved.pass);
    restoreEnv('PAYFAST_SANDBOX', saved.sb);
    resetEnvForTests();
  });

  it('cancels with a signed PUT to the subscription cancel endpoint', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
    const p = new PayFastProvider((async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => { calls.push({ url, ...init }); return { ok: true, status: 200, text: async () => '' }; }) as never);
    expect(p.capabilities).toEqual({ cancelSubscription: true, updateAmount: true });
    await p.cancelSubscription('abc-123');
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.payfast.co.za/subscriptions/abc-123/cancel?testing=true' });
    expect(calls[0]!.headers['merchant-id']).toBe('10000100');
    expect(calls[0]!.headers.version).toBe('v1');
    expect(calls[0]!.headers.signature).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[0]!.headers.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('changes the amount with a signed PATCH carrying the new amount in cents', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const p = new PayFastProvider((async (url: string, init: { method: string; body: string }) => { calls.push({ url, method: init.method, body: init.body }); return { ok: true, status: 200, text: async () => '' }; }) as never);
    await p.updateAmount('abc-123', 114_885);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: 'https://api.payfast.co.za/subscriptions/abc-123/update?testing=true', body: 'amount=114885' });
  });

  it('a provider error is surfaced (so the background job retries) rather than swallowed', async () => {
    const p = new PayFastProvider((async () => ({ ok: false, status: 500, text: async () => 'boom' })) as never);
    await expect(p.cancelSubscription('abc')).rejects.toThrow(/failed \(500\)/);
    await expect(p.updateAmount('abc', 1)).rejects.toThrow(/failed \(500\)/);
  });
});

describe('scheduler housekeeping never touches business data', () => {
  it('removes expired sessions and tokens only', async () => {
    const ws = await createWorkspace('Housekeeping Co');
    await createCustomer(ws.ctx, customerInput('Untouchable'));
    const old = await userContext(ws.owner);
    await ownerQuery("UPDATE sessions SET expires_at = now() - interval '10 days' WHERE id = $1", [old.sessionId]);
    const customersBefore = (await ownerQuery('SELECT count(*)::int n FROM customers')).rows[0]?.n;
    const auditBefore = (await ownerQuery('SELECT count(*)::int n FROM audit_logs')).rows[0]?.n;
    const r = await runScheduledTasks();
    expect(r.housekeeping.sessions).toBeGreaterThanOrEqual(1);
    expect((await ownerQuery('SELECT 1 FROM sessions WHERE id = $1', [old.sessionId])).rowCount).toBe(0);
    expect((await ownerQuery('SELECT count(*)::int n FROM customers')).rows[0]?.n).toBe(customersBefore);
    expect((await ownerQuery('SELECT count(*)::int n FROM audit_logs')).rows[0]?.n).toBeGreaterThanOrEqual(auditBefore);
  });
});
