import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { cancelInvoice, getInvoice } from '@/server/finance/invoices';
import { getPublicInvoice, getPublicPaymentStatus, handleOnlineWebhook, startOnlinePayment } from '@/server/finance/online';
import { getCustomerCredit } from '@/server/finance/payments';
import { PayFastCustomerProvider, ProviderVerificationError, setCustomerProviderForTests, type CustomerPaymentProvider } from '@/server/finance/providers';
import { getFinanceSettings, updateFinanceSettings } from '@/server/finance/settings';
import { payfastSignature } from '@/server/billing/payfast';
import { createMemberCtx, createWorkspace, drainJobs, latestEmailTo, ownerQuery, testMeta, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice, tokenOf } from '../helpers/finance';

afterAll(async () => {
  setCustomerProviderForTests('fake', undefined);
  await disconnectPrisma();
});

const sig = (secret: string, e: { paymentId: string; amountCents: number; status: string; providerReference: string }) =>
  createHash('sha256').update(`${secret}|${e.paymentId}|${e.amountCents}|${e.status}|${e.providerReference}`).digest('hex');

/** A stand-in gateway with the same contract as a real one: hosted checkout form + signed webhook. */
const fake: CustomerPaymentProvider = {
  key: 'fake',
  label: 'Fake Pay',
  credentialFields: [{ key: 'merchantId', label: 'Merchant ID', secret: false, required: true }, { key: 'secret', label: 'Signing secret', secret: true, required: true }],
  createSession(req) {
    return { actionUrl: 'https://pay.fake.test/checkout', method: 'POST', fields: { merchant: req.credentials.merchantId!, ref: req.paymentId, amount: String(req.amountCents), return_url: req.returnUrl, notify_url: req.notifyUrl } };
  },
  async verifyWebhook(raw, ctx) {
    let body: { paymentId: string; providerReference: string; amountCents: number; status: 'COMPLETE' | 'FAILED' | 'CANCELLED' | 'PENDING'; sig: string };
    try { body = JSON.parse(raw); } catch { throw new ProviderVerificationError('not json'); }
    if (body.sig !== sig(ctx.credentials.secret!, body)) throw new ProviderVerificationError('bad signature');
    return { provider: 'fake', externalId: `${body.providerReference}:${body.status}`, eventType: `payment.${body.status.toLowerCase()}`, paymentId: body.paymentId, providerReference: body.providerReference, amountCents: body.amountCents, status: body.status, payload: { ref: body.providerReference } };
  },
};

let ws: TestWorkspace;
beforeAll(async () => {
  setCustomerProviderForTests('fake', fake);
  ws = await financeWorkspace('Online Pay Shop');
  await updateFinanceSettings(ws.ctx, { onlineProvider: 'fake', onlineCredentials: { merchantId: 'merchant-1', secret: 'top-secret-signing-key' } });
});

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

const invoiceOf = (amount: number, w = ws) => issuedInvoice(w, { send: true, lines: [L('Work', 1, amount)] });
const webhook = (w: TestWorkspace, e: { paymentId: string; amountCents: number; status?: 'COMPLETE' | 'FAILED' | 'CANCELLED' | 'PENDING'; providerReference?: string; secret?: string }) => {
  const body = { paymentId: e.paymentId, amountCents: e.amountCents, status: e.status ?? 'COMPLETE', providerReference: e.providerReference ?? `pf-${e.paymentId.slice(0, 8)}` };
  return handleOnlineWebhook('fake', w.businessId, JSON.stringify({ ...body, sig: sig(e.secret ?? 'top-secret-signing-key', body) }), { ip: '198.51.100.7' });
};

describe('payment settings', () => {
  it('stores provider credentials encrypted and never hands them back', async () => {
    const stored = await ownerQuery<{ online_credentials_enc: string }>('SELECT online_credentials_enc FROM finance_settings WHERE business_id = $1', [ws.businessId]);
    const blob = stored.rows[0]!.online_credentials_enc;
    expect(blob).toBeTruthy();
    expect(blob).not.toContain('top-secret-signing-key');
    expect(blob).not.toContain('merchant-1');
    const s = await getFinanceSettings(ws.ctx);
    const json = JSON.stringify(s);
    expect(json).not.toContain('top-secret-signing-key');
    expect(json).not.toContain('online_credentials_enc');
    expect(json).not.toContain('onlineCredentialsEnc');
    expect(s.online).toMatchObject({ provider: 'fake', configured: true, entitled: true });
    expect(s.online.fields.find((f) => f.key === 'secret')).toMatchObject({ secret: true, isSet: true, value: null });
    expect(s.online.fields.find((f) => f.key === 'merchantId')).toMatchObject({ secret: false, isSet: true, value: 'merchant-1' });
    // the audit trail records that credentials changed, not what they are
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'finance.settings_changed'", [ws.businessId]);
    expect(JSON.stringify(audit.rows)).not.toContain('top-secret');
    expect(audit.rows.some((r) => r.metadata.onlineCredentialsChanged === true)).toBe(true);
  });

  it('keeps secrets that are not re-sent, validates what is required, and rejects unknown fields and providers', async () => {
    await updateFinanceSettings(ws.ctx, { onlineCredentials: { merchantId: 'merchant-2' } });
    const cfg = await getFinanceSettings(ws.ctx);
    expect(cfg.online.fields.find((f) => f.key === 'merchantId')!.value).toBe('merchant-2');
    expect(cfg.online.configured).toBe(true);
    expect((await err(updateFinanceSettings(ws.ctx, { onlineCredentials: { bogus: 'x' } }))).code).toBe('VALIDATION_ERROR');
    expect((await err(updateFinanceSettings(ws.ctx, { onlineProvider: 'nonexistent' }))).code).toBe('VALIDATION_ERROR');
    await updateFinanceSettings(ws.ctx, { onlineCredentials: { merchantId: 'merchant-1' } });
  });

  it('is limited to people who manage payment settings, and to plans that include online payments', async () => {
    const advisor = await createMemberCtx(ws, 'service_advisor');
    expect((await err(updateFinanceSettings(advisor.ctx, { paymentTermsDays: 30 }))).code).toBe('FORBIDDEN');
    const solo = await financeWorkspace('Solo Shop');
    await upgradePlan(solo, 'solo');
    const e = await err(updateFinanceSettings(solo.ctx, { onlineProvider: 'fake', onlineCredentials: { merchantId: 'm', secret: 's' } }));
    expect(e.code).toBe('FEATURE_NOT_IN_PLAN');
    const e2 = await err(updateFinanceSettings(solo.ctx, { remindersEnabled: true }));
    expect(e2.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await updateFinanceSettings(solo.ctx, { paymentTermsDays: 30, invoicePrefix: 'tax' })).paymentTermsDays).toBe(30); // core settings stay available
  });

  it('validates numbering and terms', async () => {
    for (const bad of [{ invoicePrefix: 'with space' }, { invoicePrefix: '' }, { numberPadding: 2 }, { numberPadding: 12 }, { quoteValidityDays: 0 }, { paymentTermsDays: 400 }, { enabledMethods: [] }]) {
      expect((await err(updateFinanceSettings(ws.ctx, bad))).code, JSON.stringify(bad)).toBe('VALIDATION_ERROR');
    }
    const ok = await updateFinanceSettings(ws.ctx, { quotePrefix: 'est', quoteTerms: '', paymentInstructions: 'Pay by EFT' });
    expect(ok).toMatchObject({ quotePrefix: 'EST', quoteTerms: null, paymentInstructions: 'Pay by EFT' });
    await updateFinanceSettings(ws.ctx, { quotePrefix: 'QUO' });
  });
});

describe('paying online', () => {
  it('offers online payment only when configured and entitled; the checkout carries our payment id, never secrets', async () => {
    const inv = await invoiceOf(100_000);
    const token = tokenOf(inv.customerUrl!);
    const view = await getPublicInvoice(token, testMeta());
    expect(view.payment.online).toMatchObject({ provider: 'Fake Pay' });
    const started = await startOnlinePayment(token, {}, testMeta());
    expect(started.session).toMatchObject({ actionUrl: 'https://pay.fake.test/checkout', method: 'POST' });
    expect(started.session.fields.ref).toBe(started.paymentId);
    expect(started.session.fields.amount).toBe('100000');
    expect(JSON.stringify(started)).not.toContain('top-secret');
    expect(started.session.fields.notify_url).toBe(`http://localhost:3000/api/webhooks/payments/fake/${ws.businessId}`);
    const p = await ownerQuery('SELECT status, method, provider, amount_cents FROM payments WHERE id = $1', [started.paymentId]);
    expect(p.rows[0]).toMatchObject({ status: 'PENDING', method: 'ONLINE', provider: 'fake', amount_cents: 100_000 });
    // starting again straight away reuses the pending payment
    expect((await startOnlinePayment(token, {}, testMeta())).paymentId).toBe(started.paymentId);
    // the invoice has not changed: nothing is paid until the provider confirms
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ paidCents: 0, outstandingCents: 100_000 });
  });

  it('allows a part payment but never more than is owed, and refuses when nothing is owed or it is not set up', async () => {
    const inv = await invoiceOf(100_000);
    const token = tokenOf(inv.customerUrl!);
    expect((await startOnlinePayment(token, { amountCents: 25_000 }, testMeta())).session.fields.amount).toBe('25000');
    expect((await err(startOnlinePayment(token, { amountCents: 100_001 }, testMeta()))).code).toBe('VALIDATION_ERROR');
    expect((await err(startOnlinePayment(token, { amountCents: 0 }, testMeta()))).code).toBe('VALIDATION_ERROR');
    const plain = await financeWorkspace('No Gateway Shop');
    const inv2 = await issuedInvoice(plain, { send: true });
    expect((await err(startOnlinePayment(tokenOf(inv2.customerUrl!), {}, testMeta()))).details).toMatchObject({ code: 'ONLINE_NOT_AVAILABLE' });
  });

  it('a browser coming back from the provider proves nothing and changes nothing', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    const status = await getPublicPaymentStatus(ws.businessId, started.paymentId);
    expect(status).toMatchObject({ status: 'PENDING', amountCents: 100_000 });
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ paidCents: 0, status: expect.stringMatching(/SENT|VIEWED/) });
    expect((await err(getPublicPaymentStatus(ws.businessId, '00000000-0000-4000-8000-000000000000'))).code).toBe('NOT_FOUND');
    expect((await err(getPublicPaymentStatus('not-a-uuid', started.paymentId))).code).toBe('NOT_FOUND');
  });
});

describe('the provider webhook', () => {
  it('completes the payment once verified: balance, receipt, audit and the customer email follow', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000 })).toEqual({ result: 'processed' });
    const got = await getInvoice(ws.ctx, inv.id);
    expect(got.invoice).toMatchObject({ status: 'PAID', paidCents: 100_000, outstandingCents: 0 });
    expect(got.payments[0]).toMatchObject({ status: 'COMPLETED', method: 'ONLINE', provider: 'fake', amountCents: 100_000 });
    expect(got.payments[0]!.receipt?.number).toMatch(/^RCT-/);
    const audit = await ownerQuery("SELECT user_id, metadata FROM audit_logs WHERE resource_id = $1 AND action = 'payment.completed'", [started.paymentId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.user_id).toBeNull();
    expect(audit.rows[0]!.metadata).toMatchObject({ fromProvider: true, amountCents: 100_000 });
    const c = await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [inv.customerId]);
    expect((await latestEmailTo(c.rows[0]!.email))?.subject).toContain('Payment received');
    const ev = await ownerQuery("SELECT status FROM webhook_events WHERE provider = 'customer:fake' AND external_id LIKE $1", [`${ws.businessId}:%`]);
    expect(ev.rows.every((r) => r.status === 'PROCESSED')).toBe(true);
    expect((await getPublicPaymentStatus(ws.businessId, started.paymentId)).status).toBe('COMPLETED');
  });

  it('the same webhook delivered again, or twice at once, never creates a second payment or moves the balance twice', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    const results = await Promise.all([webhook(ws, { paymentId: started.paymentId, amountCents: 100_000 }), webhook(ws, { paymentId: started.paymentId, amountCents: 100_000 }), webhook(ws, { paymentId: started.paymentId, amountCents: 100_000 })]);
    expect(results.filter((r) => r.result === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'duplicate')).toHaveLength(2);
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000 })).toEqual({ result: 'duplicate' });
    const got = await getInvoice(ws.ctx, inv.id);
    expect(got.payments).toHaveLength(1);
    expect(got.invoice).toMatchObject({ paidCents: 100_000, outstandingCents: 0 });
    expect((await ownerQuery('SELECT count(*)::int AS n FROM receipts WHERE payment_id = $1', [started.paymentId])).rows[0]!.n).toBe(1);
    // a redelivery under a different event id for the same completed payment is also harmless
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000, providerReference: 'another-delivery-id' })).toMatchObject({ result: expect.stringMatching(/duplicate|ignored/) });
    expect((await getInvoice(ws.ctx, inv.id)).invoice.paidCents).toBe(100_000);
  });

  it('rejects a webhook with a bad signature, from the wrong business, or in a broken form, and changes nothing', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000, secret: 'guessed-wrong' })).toEqual({ result: 'rejected' });
    expect(await handleOnlineWebhook('fake', ws.businessId, 'garbage', {})).toEqual({ result: 'rejected' });
    expect(await handleOnlineWebhook('fake', 'not-a-uuid', '{}', {})).toEqual({ result: 'rejected' });
    expect(await handleOnlineWebhook('unknown-provider', ws.businessId, '{}', {})).toEqual({ result: 'rejected' });
    const other = await financeWorkspace('Other Gateway Shop'); // has no gateway configured
    expect(await webhook(other, { paymentId: started.paymentId, amountCents: 100_000 })).toEqual({ result: 'rejected' });
    const unrelated = await financeWorkspace('Different Credentials');
    await updateFinanceSettings(unrelated.ctx, { onlineProvider: 'fake', onlineCredentials: { merchantId: 'x', secret: 'their-own-secret' } });
    // a payment id belonging to another business is "unknown" to that business even with a valid signature of its own
    expect(await webhook(unrelated, { paymentId: started.paymentId, amountCents: 100_000, secret: 'their-own-secret' })).toMatchObject({ result: 'ignored' });
    expect((await getInvoice(ws.ctx, inv.id)).invoice.paidCents).toBe(0);
    expect((await ownerQuery('SELECT status FROM payments WHERE id = $1', [started.paymentId])).rows[0]!.status).toBe('PENDING');
  });

  it('ignores a payment whose amount does not match what we asked for (a tampered or mistaken amount)', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 1 })).toMatchObject({ result: 'ignored', reason: 'amount mismatch' });
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_001, providerReference: 'pf-other-ref' })).toMatchObject({ result: 'ignored' });
    expect((await getInvoice(ws.ctx, inv.id)).invoice.paidCents).toBe(0);
    expect(await webhook(ws, { paymentId: '00000000-0000-4000-8000-000000000000', amountCents: 100_000 })).toMatchObject({ result: 'ignored' });
  });

  it('records a failed attempt, tells the customer, and still accepts a later confirmed payment', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000, status: 'FAILED', providerReference: 'pf-fail-1' })).toEqual({ result: 'processed' });
    expect((await ownerQuery('SELECT status, failure_reason FROM payments WHERE id = $1', [started.paymentId])).rows[0]).toMatchObject({ status: 'FAILED' });
    expect((await getInvoice(ws.ctx, inv.id)).invoice.paidCents).toBe(0);
    const c = await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [inv.customerId]);
    expect((await latestEmailTo(c.rows[0]!.email))?.subject).toContain('did not go through');
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'payment.failed'", [started.paymentId])).rows).toHaveLength(1);
    // the provider later confirms the money really moved: that wins
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000, status: 'COMPLETE', providerReference: 'pf-ok-1' })).toEqual({ result: 'processed' });
    expect((await getInvoice(ws.ctx, inv.id)).invoice.status).toBe('PAID');
  });

  it('a pending notice moves the payment to processing and nothing else', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000, status: 'PENDING', providerReference: 'pf-pending-1' });
    expect((await ownerQuery('SELECT status FROM payments WHERE id = $1', [started.paymentId])).rows[0]!.status).toBe('PROCESSING');
    expect((await getInvoice(ws.ctx, inv.id)).invoice.paidCents).toBe(0);
  });

  it('money that arrives for an invoice that was cancelled meanwhile is kept as customer credit, never lost', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    await cancelInvoice(ws.ctx, inv.id, { reason: 'Reissue' });
    expect(await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000 })).toEqual({ result: 'processed' });
    expect((await getInvoice(ws.ctx, inv.id)).invoice).toMatchObject({ status: 'CANCELLED', paidCents: 0 });
    expect((await getCustomerCredit(ws.ctx, inv.customerId)).balanceCents).toBe(100_000);
  });

  it('keeps working while the business is read-only (money that has moved is always recorded)', async () => {
    const w = await financeWorkspace('Lapsed Shop');
    await updateFinanceSettings(w.ctx, { onlineProvider: 'fake', onlineCredentials: { merchantId: 'm', secret: 'lapsed-secret' } });
    const inv = await invoiceOf(50_000, w);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    await ownerQuery("UPDATE subscriptions SET status = 'EXPIRED', trial_ends_at = now() - interval '30 days', current_period_end = now() - interval '30 days' WHERE business_id = $1", [w.businessId]);
    expect(await webhook(w, { paymentId: started.paymentId, amountCents: 50_000, secret: 'lapsed-secret' })).toEqual({ result: 'processed' });
    expect((await ownerQuery('SELECT status FROM payments WHERE id = $1', [started.paymentId])).rows[0]!.status).toBe('COMPLETED');
    await drainJobs();
  });
});

describe('PayFast (the first real provider)', () => {
  const creds = { merchantId: '10000100', merchantKey: '46f0cd694581a', passphrase: 'jt7NOE43FZPn' };

  it('builds a signed checkout that does not leak the passphrase', () => {
    const s = new PayFastCustomerProvider().createSession({
      paymentId: 'pay-1', description: 'Invoice INV-000001', amountCents: 123_456, payer: { name: 'Sam', email: 'sam@example.test' }, returnUrl: 'https://app.test/return', cancelUrl: 'https://app.test/cancel',
      notifyUrl: 'https://app.test/notify', sandbox: true, credentials: creds,
    });
    expect(s.actionUrl).toBe('https://sandbox.payfast.co.za/eng/process');
    expect(s.fields).toMatchObject({ merchant_id: '10000100', m_payment_id: 'pay-1', amount: '1234.56', item_name: 'Invoice INV-000001' });
    expect(JSON.stringify(s)).not.toContain('jt7NOE43FZPn');
    const { signature, ...rest } = s.fields;
    expect(signature).toBe(payfastSignature(Object.entries(rest), creds.passphrase));
    expect(new PayFastCustomerProvider().createSession({ paymentId: 'p', description: 'x', amountCents: 100, payer: { name: 'a' }, returnUrl: 'r', cancelUrl: 'c', notifyUrl: 'n', sandbox: false, credentials: creds }).actionUrl).toBe('https://www.payfast.co.za/eng/process');
  });

  const itn = (over: Record<string, string> = {}, passphrase = creds.passphrase) => {
    const pairs: [string, string][] = Object.entries({ m_payment_id: 'pay-1', pf_payment_id: '1089250', payment_status: 'COMPLETE', amount_gross: '1234.56', merchant_id: creds.merchantId, ...over });
    return new URLSearchParams([...pairs, ['signature', payfastSignature(pairs, passphrase)]]).toString();
  };

  it('verifies a genuine ITN with PayFast\'s own confirmation, and refuses anything else', async () => {
    const valid = new PayFastCustomerProvider(async () => ({ text: async () => 'VALID' }));
    const e = await valid.verifyWebhook(itn(), { credentials: creds, sandbox: true });
    expect(e).toMatchObject({ provider: 'payfast', paymentId: 'pay-1', providerReference: '1089250', amountCents: 123_456, status: 'COMPLETE', externalId: '1089250:COMPLETE' });
    await expect(valid.verifyWebhook(itn({}, 'wrong-passphrase'), { credentials: creds, sandbox: true })).rejects.toBeInstanceOf(ProviderVerificationError);
    await expect(valid.verifyWebhook(itn({ merchant_id: '999' }), { credentials: creds, sandbox: true })).rejects.toThrow(/merchant/);
    await expect(valid.verifyWebhook('payment_status=COMPLETE', { credentials: creds, sandbox: true })).rejects.toThrow(/signature/);
    const invalid = new PayFastCustomerProvider(async () => ({ text: async () => 'INVALID' }));
    await expect(invalid.verifyWebhook(itn(), { credentials: creds, sandbox: true })).rejects.toThrow(/validation/);
    await expect(valid.verifyWebhook(itn({ amount_gross: 'lots' }), { credentials: creds, sandbox: true })).rejects.toThrow(/amount/);
    expect((await valid.verifyWebhook(itn({ payment_status: 'CANCELLED' }), { credentials: creds, sandbox: true })).status).toBe('CANCELLED');
  });
});

describe('isolation', () => {
  it('the SaaS subscription gateway and customer payments are separate domains', async () => {
    const inv = await invoiceOf(100_000);
    const started = await startOnlinePayment(tokenOf(inv.customerUrl!), {}, testMeta());
    await webhook(ws, { paymentId: started.paymentId, amountCents: 100_000 });
    // customer money never touches the workshop's own TFME subscription records
    expect((await ownerQuery('SELECT count(*)::int AS n FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rows[0]!.n).toBe(0);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM subscription_invoices WHERE business_id = $1', [ws.businessId])).rows[0]!.n).toBe(0);
    const sub = await ownerQuery('SELECT status FROM subscriptions WHERE business_id = $1', [ws.businessId]);
    expect(sub.rows[0]!.status).toBe('TRIALING');
    const other = await createWorkspace('Gateway Spy');
    expect((await err(updateFinanceSettings(other.ctx, { onlineProvider: 'nonexistent' }))).code).toBeDefined();
  });
});
