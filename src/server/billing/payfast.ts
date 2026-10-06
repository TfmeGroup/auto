import { createHash } from 'node:crypto';
import { env } from '@/lib/env';
import { parseDecimalToCents, centsToDecimal, MoneyError } from '@/lib/money';
import { safeEqual } from '@/server/security/crypto';
import {
  WebhookVerificationError,
  type CheckoutForm,
  type CheckoutRequest,
  type PaymentProvider,
  type ProviderPaymentStatus,
  type VerifiedWebhook,
} from './provider';

/** PHP-style urlencode, which is what PayFast signs against. */
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/** md5 over `k=v&k=v...` (in the given order) plus the passphrase, per PayFast's signature spec. */
export function payfastSignature(pairs: [string, string][], passphrase?: string): string {
  const parts = pairs.map(([k, v]) => `${k}=${phpUrlencode(v.trim())}`);
  if (passphrase) parts.push(`passphrase=${phpUrlencode(passphrase.trim())}`);
  return createHash('md5').update(parts.join('&')).digest('hex');
}

const HOSTS = {
  sandbox: 'https://sandbox.payfast.co.za',
  live: 'https://www.payfast.co.za',
} as const;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ text(): Promise<string>; ok?: boolean; status?: number }>;

export class PayFastProvider implements PaymentProvider {
  readonly name = 'payfast';
  readonly capabilities = { cancelSubscription: true, updateAmount: true };

  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  private get host() {
    return env().PAYFAST_SANDBOX ? HOSTS.sandbox : HOSTS.live;
  }

  createCheckout(req: CheckoutRequest): CheckoutForm {
    const e = env();
    const amount = centsToDecimal(req.amountCents);
    // Field ORDER matters: the signature is computed over the fields in this order.
    const ordered: [string, string][] = [
      ['merchant_id', e.PAYFAST_MERCHANT_ID ?? ''],
      ['merchant_key', e.PAYFAST_MERCHANT_KEY ?? ''],
      ['return_url', req.returnUrl],
      ['cancel_url', req.cancelUrl],
      ['notify_url', req.notifyUrl],
      ['name_first', req.payer.name.slice(0, 100)],
      ['email_address', req.payer.email],
      ['m_payment_id', req.paymentId],
      ['amount', amount],
      ['item_name', req.itemName.slice(0, 100)],
      // Monthly recurring subscription, indefinite.
      ['subscription_type', '1'],
      ['recurring_amount', amount],
      ['frequency', '3'],
      ['cycles', '0'],
    ];
    const present = ordered.filter(([, v]) => v !== '');
    const signature = payfastSignature(present, e.PAYFAST_PASSPHRASE);
    return {
      actionUrl: `${this.host}/eng/process`,
      fields: { ...Object.fromEntries(present), signature },
    };
  }

  /**
   * PayFast's subscription API (cancel / change amount). Requests are signed: md5 over the header
   * and body parameters, sorted alphabetically, plus the passphrase.
   * STATUS: implemented from PayFast's published API description and covered by tests with a
   * stubbed HTTP client; NOT yet exercised against PayFast's live sandbox.
   */
  private async api(method: 'PUT' | 'PATCH', path: string, body: Record<string, string> = {}): Promise<void> {
    const e = env();
    const headerParams: Record<string, string> = {
      'merchant-id': e.PAYFAST_MERCHANT_ID ?? '',
      version: 'v1',
      timestamp: new Date().toISOString().slice(0, 19),
    };
    const forSignature: Record<string, string> = { ...headerParams, ...body };
    if (e.PAYFAST_PASSPHRASE) forSignature.passphrase = e.PAYFAST_PASSPHRASE;
    const signature = payfastSignature(Object.entries(forSignature).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const query = e.PAYFAST_SANDBOX ? '?testing=true' : '';
    const res = (await this.fetchImpl(`https://api.payfast.co.za${path}${query}`, {
      method,
      headers: { ...headerParams, signature, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    })) as { ok?: boolean; status?: number; text(): Promise<string> };
    if (res.ok === false || (res.status !== undefined && res.status >= 400)) {
      throw new Error(`PayFast API ${method} ${path} failed (${res.status ?? 'error'})`);
    }
  }

  async cancelSubscription(ref: string): Promise<void> {
    await this.api('PUT', `/subscriptions/${encodeURIComponent(ref)}/cancel`);
  }

  async updateAmount(ref: string, amountCents: number): Promise<void> {
    await this.api('PATCH', `/subscriptions/${encodeURIComponent(ref)}/update`, { amount: String(amountCents) });
  }

  async verifyWebhook(rawBody: string, _ctx?: { ip?: string }): Promise<VerifiedWebhook> {
    void _ctx; // provider-side validation below is the authoritative check, not the source IP
    const e = env();
    const entries = [...new URLSearchParams(rawBody).entries()];
    const received = entries.find(([k]) => k === 'signature')?.[1];
    const pairs = entries.filter(([k]) => k !== 'signature') as [string, string][];
    if (!received || pairs.length === 0) throw new WebhookVerificationError('missing signature');

    // PayFast documents blank handling inconsistently across versions, so accept either
    // canonicalisation. Both require the secret passphrase, so neither can be forged.
    const withBlanks = payfastSignature(pairs, e.PAYFAST_PASSPHRASE);
    const withoutBlanks = payfastSignature(pairs.filter(([, v]) => v !== ''), e.PAYFAST_PASSPHRASE);
    if (!safeEqual(received.toLowerCase(), withBlanks) && !safeEqual(received.toLowerCase(), withoutBlanks)) {
      throw new WebhookVerificationError('bad signature');
    }

    const data = Object.fromEntries(pairs);
    if (data.merchant_id !== e.PAYFAST_MERCHANT_ID) throw new WebhookVerificationError('merchant mismatch');

    // Server-to-server confirmation with PayFast: the authoritative check.
    const paramString = pairs.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join('&');
    const res = await this.fetchImpl(`${this.host}/eng/query/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: paramString,
    });
    if ((await res.text()).trim() !== 'VALID') throw new WebhookVerificationError('provider validation failed');

    const providerPaymentId = data.pf_payment_id;
    const paymentId = data.m_payment_id;
    if (!providerPaymentId || !paymentId) throw new WebhookVerificationError('missing identifiers');

    let amountCents: number;
    try {
      amountCents = parseDecimalToCents(data.amount_gross ?? '');
    } catch (err) {
      if (err instanceof MoneyError) throw new WebhookVerificationError('bad amount');
      throw err;
    }

    const rawStatus = (data.payment_status ?? '').toUpperCase();
    const status: ProviderPaymentStatus =
      rawStatus === 'COMPLETE' || rawStatus === 'FAILED' || rawStatus === 'CANCELLED' ? rawStatus : 'PENDING';

    const { token, signature: _s, merchant_id: _m, ...payload } = data;
    void _s;
    void _m;
    return {
      provider: this.name,
      externalId: `${providerPaymentId}:${status}`,
      eventType: `payment.${status.toLowerCase()}`,
      paymentId,
      providerPaymentId,
      amountCents,
      status,
      subscriptionRef: token || undefined,
      payload,
    };
  }
}
