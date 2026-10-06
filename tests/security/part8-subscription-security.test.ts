import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { startCheckout } from '@/server/billing/plan-change';
import { setPaymentProviderForTests, WebhookVerificationError, type PaymentProvider, type VerifiedWebhook } from '@/server/billing/provider';
import { handleWebhook } from '@/server/billing/webhooks';
import { listInvoices } from '@/server/finance/invoices';
import { PATCH as businessPatch } from '@/app/api/v1/business/route';
import { POST as checkoutRoute } from '@/app/api/v1/billing/checkout/route';
import { POST as locationsPost } from '@/app/api/v1/locations/route';
import { POST as inviteRoute } from '@/app/api/v1/members/route';
import { call } from '../helpers/http';
import { businessContext, createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { financeWorkspace, issuedInvoice, pay } from '../helpers/finance';

afterAll(disconnectPrisma);

class Fake implements PaymentProvider {
  readonly name = 'fake';
  capabilities = { cancelSubscription: true, updateAmount: true };
  next: VerifiedWebhook | null = null;
  createCheckout() { return { actionUrl: 'https://pay.test/process', fields: { m: '1' } }; }
  async verifyWebhook(): Promise<VerifiedWebhook> {
    if (!this.next) throw new WebhookVerificationError('nothing queued');
    return this.next;
  }
  async cancelSubscription() {}
  async updateAmount() {}
}
const fake = new Fake();
beforeAll(async () => {
  await ownerQuery("UPDATE plans SET price_cents = CASE key WHEN 'solo' THEN 49900 WHEN 'team' THEN 99900 WHEN 'business' THEN 199900 END WHERE key IN ('solo','team','business')");
  setPaymentProviderForTests(fake);
});

const subRow = async (ws: TestWorkspace) =>
  (await ownerQuery('SELECT * FROM subscriptions WHERE business_id = $1', [ws.businessId])).rows[0]!;
const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
};

describe('nobody can change their own plan, state, trial or limits through the application', () => {
  it('forged fields on business, location and invitation requests change nothing', async () => {
    const ws = await createWorkspace('Tamper P8 Co');
    const owner = ws.ctx.token;
    const before = await subRow(ws);
    const forged = {
      plan: 'business', planId: before.plan_id, planKey: 'business', status: 'ACTIVE', subscription: { status: 'ACTIVE', plan: 'custom' },
      trialEndsAt: '2099-01-01T00:00:00Z', trial_ends_at: '2099-01-01T00:00:00Z', maxMembers: 9999, maxLocations: 9999, overrideMaxMembers: 9999,
      provider: 'payfast', providerSubscriptionRef: 'tok_stolen', currentPeriodEnd: '2099-01-01T00:00:00Z', features: ['custom_reports'],
    };
    const r1 = await call(businessPatch, { method: 'PATCH', token: owner, body: { name: 'Tamper P8 Co', ...forged } });
    expect([200, 422]).toContain(r1.status);
    const r2 = await call(locationsPost, { method: 'POST', token: owner, body: { name: 'Branch', ...forged } });
    expect([201, 402, 422]).toContain(r2.status);
    const role = (await ownerQuery<{ id: string }>("SELECT id FROM roles WHERE business_id IS NULL AND key = 'technician'")).rows[0]!.id;
    const r3 = await call(inviteRoute, { method: 'POST', token: owner, headers: { 'x-plan': 'business', 'x-subscription-status': 'ACTIVE' }, body: { email: `t.${Date.now()}@example.test`, roleId: role, ...forged } });
    expect([201, 402, 422]).toContain(r3.status);
    const after = await subRow(ws);
    for (const k of ['plan_id', 'status', 'trial_ends_at', 'current_period_end', 'provider', 'provider_subscription_ref', 'override_max_members', 'override_max_locations', 'override_max_storage_mb']) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect((await businessContext(ws.owner)).subscription.planKey).toBe('trial');
  });

  it('checkout trusts only the plan key: the amount and status are the server\'s, and the plan is NOT granted by the click', async () => {
    const ws = await createWorkspace('Checkout P8 Co');
    const before = await subRow(ws);
    const r = await call(checkoutRoute, { method: 'POST', token: ws.ctx.token, body: { planKey: 'team', amountCents: 1, status: 'COMPLETE', subscriptionRef: 'tok_x', paid: true } });
    expect([200, 201, 422]).toContain(r.status);
    const pay1 = (await ownerQuery<{ amount_cents: number; status: string }>('SELECT amount_cents, status FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rows;
    for (const p of pay1) {
      expect(p.status).toBe('PENDING');
      expect(p.amount_cents).toBe(99_900 + Math.round(99_900 * 0.15));
    }
    const after = await subRow(ws);
    expect(after.plan_id).toEqual(before.plan_id);
    expect(after.status).toBe('TRIALING');
  });

  it('a verified webhook for ANOTHER business\'s payment, a wrong amount or an unknown reference changes nothing', async () => {
    const a = await createWorkspace('Hook A P8');
    const b = await createWorkspace('Hook B P8');
    await startCheckout(a.ctx, 'team');
    const pa = (await ownerQuery<{ id: string; amount_cents: number }>('SELECT id, amount_cents FROM subscription_payments WHERE business_id = $1', [a.businessId])).rows[0]!;
    const ev = (over: Partial<VerifiedWebhook>): VerifiedWebhook => ({ provider: 'fake', externalId: `x-${Math.random()}`, eventType: 'payment.complete', paymentId: pa.id, providerPaymentId: 'p1', amountCents: pa.amount_cents, status: 'COMPLETE', payload: {}, ...over });
    const bBefore = await subRow(b);
    fake.next = ev({ amountCents: pa.amount_cents - 1 }); // underpaid
    await handleWebhook(fake, 'raw', {});
    fake.next = ev({ paymentId: 'not-a-uuid' });
    await handleWebhook(fake, 'raw', {});
    expect((await subRow(a)).status).toBe('TRIALING');
    expect(await subRow(b)).toEqual(bBefore);
    // the genuine event applies once, to the right business only, even when delivered twice
    const ok = ev({ subscriptionRef: 'tok_a' });
    fake.next = ok;
    await handleWebhook(fake, 'raw', {});
    await handleWebhook(fake, 'raw', {});
    expect((await subRow(a)).status).toBe('ACTIVE');
    expect((await subRow(b)).status).toBe('TRIALING');
    expect((await ownerQuery('SELECT 1 FROM subscription_invoices WHERE business_id = $1', [a.businessId])).rowCount).toBe(1);
  });

  it('only the billing, closure and platform code ever writes a subscription (static check)', () => {
    const allowed = [/server[\\/]billing[\\/]/, /server[\\/]businesses[\\/]service\.ts$/, /server[\\/]platform[\\/]service\.ts$/];
    const offenders = walk('src').filter((f) => !f.includes('generated') && !allowed.some((re) => re.test(f)))
      .filter((f) => /\b(subscription|subscriptionPayment|subscriptionInvoice)\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    // and no browser-callable route grants a plan: only checkout (which creates a PENDING payment) and the verified webhook
    const routes = walk('src/app/api').filter((f) => /subscription\.(update|create)/.test(readFileSync(f, 'utf8')));
    expect(routes).toEqual([]);
  });
});

describe('workshop customer money and TFME subscription money never mix', () => {
  it('a customer paying the workshop does not touch the subscription, and the subscription payment is not in the workshop\'s finances', async () => {
    const ws = await financeWorkspace('Domains P8 Co');
    const inv = await issuedInvoice(ws, { send: true });
    const subBefore = await subRow(ws);
    const subPaymentsBefore = (await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rows[0]!.n;
    await pay(ws, inv.id, 50_000, 'EFT');
    expect(await subRow(ws)).toEqual(subBefore);
    expect((await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rows[0]!.n).toBe(subPaymentsBefore);

    const counts = async () => (await ownerQuery<Record<string, number>>(
      `SELECT (SELECT count(*) FROM payments WHERE business_id = $1)::int AS payments, (SELECT count(*) FROM invoices WHERE business_id = $1)::int AS invoices,
              (SELECT count(*) FROM receipts WHERE business_id = $1)::int AS receipts, (SELECT count(*) FROM customer_credit_entries WHERE business_id = $1)::int AS credit`, [ws.businessId])).rows[0]!;
    const finBefore = await counts();
    await startCheckout(ws.ctx, 'team');
    const p = (await ownerQuery<{ id: string; amount_cents: number }>('SELECT id, amount_cents FROM subscription_payments WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1', [ws.businessId])).rows[0]!;
    fake.next = { provider: 'fake', externalId: `sub-${Math.random()}`, eventType: 'payment.complete', paymentId: p.id, providerPaymentId: 'pp', amountCents: p.amount_cents, status: 'COMPLETE', payload: {}, subscriptionRef: 'tok_dom' };
    await handleWebhook(fake, 'raw', {});
    expect((await subRow(ws)).status).toBe('ACTIVE');
    expect(await counts()).toEqual(finBefore); // the workshop's own ledger is untouched
    const list = await listInvoices(ws.ctx, {});
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/TFME|subscription/i);
  });

  it('the finance tables have no reference to subscriptions, and the subscription tables none to customers', async () => {
    const fk = await ownerQuery<{ t: string; r: string }>(
      `SELECT c.conrelid::regclass::text AS t, c.confrelid::regclass::text AS r FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    const finance = ['payments', 'invoices', 'receipts', 'quotes', 'credit_notes', 'refunds', 'customer_credit_entries'];
    const sub = ['subscriptions', 'subscription_payments', 'subscription_invoices', 'subscription_events'];
    const cross = fk.rows.filter((x) => (finance.includes(x.t) && sub.includes(x.r)) || (sub.includes(x.t) && finance.concat(['customers', 'vehicles']).includes(x.r)));
    expect(cross).toEqual([]);
  });

  it('a technician cannot see or start anything on the subscription', async () => {
    const ws = await createWorkspace('Billing Perm P8');
    const tech = await createMemberCtx(ws, 'technician');
    expect((await call(checkoutRoute, { method: 'POST', token: tech.ctx.token, body: { planKey: 'team' } })).status).toBe(403);
  });
});
