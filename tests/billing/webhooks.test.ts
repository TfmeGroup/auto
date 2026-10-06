import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { resetEnvForTests } from '@/lib/env';
import { startCheckout } from '@/server/billing/checkout';
import { PayFastProvider, payfastSignature } from '@/server/billing/payfast';
import { setPaymentProviderForTests, WebhookVerificationError, type PaymentProvider, type VerifiedWebhook } from '@/server/billing/provider';
import { handleWebhook } from '@/server/billing/webhooks';
import { POST as webhookRoute } from '@/app/api/webhooks/[provider]/route';
import { createMemberCtx, createWorkspace, ownerQuery, restoreEnv, type TestWorkspace } from '../helpers/factory';

afterAll(disconnectPrisma);

const MERCHANT = '10000100';
const PASSPHRASE = 'test-passphrase';

/** A provider whose verification we control, to test the processing pipeline itself. */
class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly capabilities = { cancelSubscription: true, updateAmount: true };
  next: VerifiedWebhook | Error | null = null;
  createCheckout() {
    return { actionUrl: 'https://pay.test/process', fields: { m: '1' } };
  }
  async verifyWebhook(): Promise<VerifiedWebhook> {
    if (this.next instanceof Error) throw this.next;
    if (!this.next) throw new WebhookVerificationError('nothing queued');
    return this.next;
  }
}

const fake = new FakeProvider();
let seq = 0;

async function pendingPayment(ws: TestWorkspace, planKey = 'team') {
  setPaymentProviderForTests(fake);
  await startCheckout(ws.ctx, planKey);
  const p = await ownerQuery<{ id: string; amount_cents: number }>(
    "SELECT id, amount_cents FROM subscription_payments WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1",
    [ws.businessId],
  );
  return { id: p.rows[0]!.id, amountCents: p.rows[0]!.amount_cents };
}

const event = (over: Partial<VerifiedWebhook> & { paymentId: string; amountCents: number }): VerifiedWebhook => {
  const id = `pf-${Date.now()}-${++seq}`;
  const status = over.status ?? 'COMPLETE';
  return {
    provider: 'fake', externalId: `${id}:${status}`, eventType: `payment.${status.toLowerCase()}`,
    providerPaymentId: id, status, payload: { note: 'test' }, ...over,
  };
};

const sub = async (businessId: string) =>
  (await ownerQuery('SELECT s.status, s.current_period_end, s.cancel_at_period_end, p.key AS plan FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE business_id = $1', [businessId])).rows[0];

// Prices are intentionally unset in the catalogue; checkout refuses unpriced plans. Tests set them.
beforeAll(async () => {
  await ownerQuery("UPDATE plans SET price_cents = CASE key WHEN 'solo' THEN 49900 WHEN 'team' THEN 99900 WHEN 'business' THEN 199900 END WHERE key IN ('solo','team','business')");
});

afterEach(() => {
  fake.next = null;
  setPaymentProviderForTests(undefined);
});

describe('checkout never changes payment state by itself', () => {
  it('creates a PENDING payment we own and leaves the subscription untouched', async () => {
    const ws = await createWorkspace('Checkout Co');
    const { id, amountCents } = await pendingPayment(ws);
    expect((await sub(ws.businessId)).status).toBe('TRIALING'); // "the browser said it paid" changes nothing
    const row = (await ownerQuery('SELECT status, provider_payment_id FROM subscription_payments WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ status: 'PENDING', provider_payment_id: null });
    expect(amountCents).toBe(Math.round(99_900 * 1.15)); // plan price + 15% VAT, computed server-side
  });

  it('requires the billing permission and a public plan', async () => {
    const ws = await createWorkspace('Checkout Perm Co');
    const tech = await createMemberCtx(ws, 'technician');
    setPaymentProviderForTests(fake);
    await expect(startCheckout(tech.ctx, 'solo')).rejects.toMatchObject({ status: 403 });
    await expect(startCheckout(ws.ctx, 'trial')).rejects.toMatchObject({ status: 404 });
    await expect(startCheckout(ws.ctx, 'no-such-plan')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to start when no provider is configured', async () => {
    const ws = await createWorkspace('No Provider Co');
    setPaymentProviderForTests(null);
    await expect(startCheckout(ws.ctx, 'solo')).rejects.toMatchObject({ status: 400 });
  });
});

describe('webhook processing', () => {
  it('a verified COMPLETE payment activates the plan and extends the period', async () => {
    const ws = await createWorkspace('Paid Co');
    const p = await pendingPayment(ws, 'team');
    fake.next = event({ paymentId: p.id, amountCents: p.amountCents, subscriptionRef: 'tok_123' });
    expect(await handleWebhook(fake, 'raw', {})).toEqual({ result: 'processed' });

    const s = await sub(ws.businessId);
    expect(s.status).toBe('ACTIVE');
    expect(s.plan).toBe('team');
    const days = (new Date(s.current_period_end).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    expect((await ownerQuery('SELECT status FROM subscription_payments WHERE id = $1', [p.id])).rows[0].status).toBe('COMPLETE');
    const audit = await ownerQuery("SELECT action FROM audit_logs WHERE business_id = $1 AND action IN ('billing.payment_received','subscription.plan_changed')", [ws.businessId]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['billing.payment_received', 'subscription.plan_changed']));
  });

  it('redelivery of the same event is harmless (idempotent)', async () => {
    const ws = await createWorkspace('Dup Co');
    const p = await pendingPayment(ws);
    const e = event({ paymentId: p.id, amountCents: p.amountCents });
    fake.next = e;
    expect(await handleWebhook(fake, 'raw', {})).toEqual({ result: 'processed' });
    const first = (await sub(ws.businessId)).current_period_end;
    for (let i = 0; i < 3; i++) expect(await handleWebhook(fake, 'raw', {})).toEqual({ result: 'duplicate' });
    expect((await sub(ws.businessId)).current_period_end).toEqual(first); // not extended again
    expect((await ownerQuery("SELECT count(*)::int n FROM webhook_events WHERE external_id = $1", [e.externalId])).rows[0].n).toBe(1);
  });

  it('simultaneous duplicate deliveries are applied exactly once', async () => {
    const ws = await createWorkspace('Race Pay Co');
    const p = await pendingPayment(ws);
    fake.next = event({ paymentId: p.id, amountCents: p.amountCents });
    const results = await Promise.all(Array.from({ length: 6 }, () => handleWebhook(fake, 'raw', {})));
    expect(results.filter((r) => r.result === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'duplicate')).toHaveLength(5);
    const days = (new Date((await sub(ws.businessId)).current_period_end).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThan(32); // a single month, not six
  });

  it('rejects unverifiable webhooks without touching any state', async () => {
    const ws = await createWorkspace('Forged Co');
    const p = await pendingPayment(ws);
    fake.next = new WebhookVerificationError('bad signature');
    expect(await handleWebhook(fake, 'forged-body', {})).toEqual({ result: 'rejected' });
    expect((await sub(ws.businessId)).status).toBe('TRIALING');
    expect((await ownerQuery('SELECT status FROM subscription_payments WHERE id = $1', [p.id])).rows[0].status).toBe('PENDING');
  });

  it('ignores an event whose amount differs from what we asked the customer to pay', async () => {
    const ws = await createWorkspace('Underpay Co');
    const p = await pendingPayment(ws, 'business');
    fake.next = event({ paymentId: p.id, amountCents: 100 }); // pays R1 for the top plan
    expect(await handleWebhook(fake, 'raw', {})).toMatchObject({ result: 'ignored', reason: 'amount mismatch' });
    expect(await sub(ws.businessId)).toMatchObject({ status: 'TRIALING', plan: 'trial' });
  });

  it('ignores events for unknown or malformed payment references', async () => {
    fake.next = event({ paymentId: '00000000-0000-4000-8000-000000000000', amountCents: 100 });
    expect(await handleWebhook(fake, 'raw', {})).toMatchObject({ result: 'ignored' });
    fake.next = event({ paymentId: "x'; DROP TABLE subscriptions;--", amountCents: 100 });
    expect(await handleWebhook(fake, 'raw', {})).toMatchObject({ result: 'ignored' });
    expect((await ownerQuery('SELECT count(*)::int n FROM subscriptions')).rows[0].n).toBeGreaterThan(0);
  });

  it('a recurring payment (same reference, new provider id) extends the period again', async () => {
    const ws = await createWorkspace('Recurring Co');
    const p = await pendingPayment(ws);
    fake.next = event({ paymentId: p.id, amountCents: p.amountCents, subscriptionRef: 'tok_r' });
    await handleWebhook(fake, 'raw', {});
    const afterFirst = new Date((await sub(ws.businessId)).current_period_end).getTime();

    fake.next = event({ paymentId: p.id, amountCents: p.amountCents, subscriptionRef: 'tok_r' });
    expect(await handleWebhook(fake, 'raw', {})).toEqual({ result: 'processed' });
    const afterSecond = new Date((await sub(ws.businessId)).current_period_end).getTime();
    expect(afterSecond - afterFirst).toBeGreaterThan(27 * 86_400_000); // stacked from the paid-through date
    expect((await ownerQuery("SELECT count(*)::int n FROM subscription_payments WHERE subscription_id = (SELECT id FROM subscriptions WHERE business_id = $1) AND status = 'COMPLETE'", [ws.businessId])).rows[0].n).toBe(2);
  });

  it('FAILED moves an active subscription to PAST_DUE; CANCELLED keeps access until the paid-through date', async () => {
    const ws = await createWorkspace('Lifecycle Co');
    const p = await pendingPayment(ws);
    fake.next = event({ paymentId: p.id, amountCents: p.amountCents });
    await handleWebhook(fake, 'raw', {});

    fake.next = event({ paymentId: p.id, amountCents: p.amountCents, status: 'FAILED' });
    await handleWebhook(fake, 'raw', {});
    expect((await sub(ws.businessId)).status).toBe('PAST_DUE');

    fake.next = event({ paymentId: p.id, amountCents: p.amountCents, status: 'CANCELLED' });
    await handleWebhook(fake, 'raw', {});
    const s = await sub(ws.businessId);
    expect(s).toMatchObject({ status: 'CANCELED', cancel_at_period_end: true });
    expect(new Date(s.current_period_end).getTime()).toBeGreaterThan(Date.now()); // paid time is not forfeited
  });

  it('a processing failure is retryable: the event is marked FAILED and reprocessed on redelivery', async () => {
    const ws = await createWorkspace('Retry Co');
    const p = await pendingPayment(ws);
    const e = event({ paymentId: p.id, amountCents: p.amountCents });
    // Simulate a transient DB problem by making the plan the payment points at unreadable once.
    await ownerQuery('ALTER TABLE subscriptions ADD CONSTRAINT tmp_block CHECK (status <> \'ACTIVE\') NOT VALID');
    fake.next = e;
    await expect(handleWebhook(fake, 'raw', {})).rejects.toThrow();
    await ownerQuery('ALTER TABLE subscriptions DROP CONSTRAINT tmp_block');
    expect((await ownerQuery('SELECT status FROM webhook_events WHERE external_id = $1', [e.externalId])).rows[0].status).toBe('FAILED');
    expect((await sub(ws.businessId)).status).toBe('TRIALING'); // rolled back cleanly

    expect(await handleWebhook(fake, 'raw', {})).toEqual({ result: 'processed' }); // provider retry succeeds
    expect((await sub(ws.businessId)).status).toBe('ACTIVE');
  });
});

describe('PayFast adapter', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { id: env.PAYFAST_MERCHANT_ID, key: env.PAYFAST_MERCHANT_KEY, pass: env.PAYFAST_PASSPHRASE, sb: env.PAYFAST_SANDBOX };

  beforeAll(() => {
    env.PAYFAST_MERCHANT_ID = MERCHANT;
    env.PAYFAST_MERCHANT_KEY = 'abc123';
    env.PAYFAST_PASSPHRASE = PASSPHRASE;
    env.PAYFAST_SANDBOX = 'true';
    resetEnvForTests();
  });
  afterAll(() => {
    restoreEnv('PAYFAST_MERCHANT_ID', saved.id);
    restoreEnv('PAYFAST_MERCHANT_KEY', saved.key);
    restoreEnv('PAYFAST_PASSPHRASE', saved.pass);
    restoreEnv('PAYFAST_SANDBOX', saved.sb);
    resetEnvForTests();
  });

  const validator = (answer: string) => async () => ({ text: async () => answer });

  const itn = (fields: Record<string, string>, opts: { sign?: boolean; passphrase?: string } = {}) => {
    const pairs = Object.entries(fields);
    const sig = opts.sign === false ? 'f'.repeat(32) : payfastSignature(pairs, opts.passphrase ?? PASSPHRASE);
    return new URLSearchParams([...pairs, ['signature', sig]]).toString();
  };
  const base = { m_payment_id: '', pf_payment_id: '1089250', payment_status: 'COMPLETE', item_name: 'TFME Auto Pro', amount_gross: '114.88', merchant_id: MERCHANT, token: 'sub-token-1' };

  it('accepts a correctly signed, provider-confirmed notification', async () => {
    const p = new PayFastProvider(validator('VALID') as never);
    const out = await p.verifyWebhook(itn({ ...base, m_payment_id: '8a1c6d52-0000-4000-8000-000000000001' }), {});
    expect(out).toMatchObject({ status: 'COMPLETE', amountCents: 11_488, providerPaymentId: '1089250', externalId: '1089250:COMPLETE', subscriptionRef: 'sub-token-1' });
    expect(out.payload).not.toHaveProperty('signature');
    expect(out.payload).not.toHaveProperty('token'); // recurring-billing token is kept out of the event log
  });

  it('rejects a bad signature, a wrong passphrase, and a tampered amount', async () => {
    const p = new PayFastProvider(validator('VALID') as never);
    const f = { ...base, m_payment_id: '8a1c6d52-0000-4000-8000-000000000002' };
    await expect(p.verifyWebhook(itn(f, { sign: false }), {})).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(p.verifyWebhook(itn(f, { passphrase: 'attacker-guess' }), {})).rejects.toBeInstanceOf(WebhookVerificationError);
    const tampered = itn(f).replace('amount_gross=114.88', 'amount_gross=1.00');
    await expect(p.verifyWebhook(tampered, {})).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(p.verifyWebhook('', {})).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a notification for another merchant, and one PayFast itself does not confirm', async () => {
    const f = { ...base, m_payment_id: '8a1c6d52-0000-4000-8000-000000000003' };
    await expect(new PayFastProvider(validator('VALID') as never).verifyWebhook(itn({ ...f, merchant_id: '99999999' }), {})).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(new PayFastProvider(validator('INVALID') as never).verifyWebhook(itn(f), {})).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('builds a signed checkout form for a monthly subscription', () => {
    const form = new PayFastProvider().createCheckout({
      paymentId: 'pay-1', itemName: 'TFME Auto Pro', amountCents: 11_488,
      payer: { name: 'Jane Doe', email: 'jane@example.test' },
      returnUrl: 'https://app.test/r', cancelUrl: 'https://app.test/c', notifyUrl: 'https://app.test/n',
    });
    expect(form.actionUrl).toBe('https://sandbox.payfast.co.za/eng/process');
    expect(form.fields).toMatchObject({ merchant_id: MERCHANT, amount: '114.88', recurring_amount: '114.88', subscription_type: '1', frequency: '3', cycles: '0', m_payment_id: 'pay-1' });
    const { signature, ...rest } = form.fields;
    expect(signature).toBe(payfastSignature(Object.entries(rest), PASSPHRASE));
  });

  it('the HTTP endpoint is closed when billing is not configured and rejects forged posts when it is', async () => {
    setPaymentProviderForTests(null);
    const closed = await webhookRoute(new Request('http://localhost/api/webhooks/payfast', { method: 'POST', body: 'x=1' }), { params: Promise.resolve({ provider: 'payfast' }) });
    expect(closed.status).toBe(404);

    setPaymentProviderForTests(new PayFastProvider(validator('VALID') as never));
    const forged = await webhookRoute(
      new Request('http://localhost/api/webhooks/payfast', { method: 'POST', headers: { 'x-real-ip': '198.51.100.9' }, body: itn({ ...base, m_payment_id: '8a1c6d52-0000-4000-8000-000000000004' }, { sign: false }) }),
      { params: Promise.resolve({ provider: 'payfast' }) },
    );
    expect(forged.status).toBe(400);
    expect((await ownerQuery("SELECT count(*)::int n FROM webhook_events WHERE provider = 'payfast'")).rows[0].n).toBe(0); // forged calls leave no state
    void prisma;
  });
});
