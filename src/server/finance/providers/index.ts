import { createHash } from 'node:crypto';
import { parseDecimalToCents, centsToDecimal, MoneyError } from '@/lib/money';
import { safeEqual } from '@/server/security/crypto';
import { payfastSignature, phpUrlencode } from '@/server/billing/payfast';

/**
 * Online payment providers for a WORKSHOP's customers (the money goes to the workshop's own merchant account).
 * This is deliberately separate from server/billing/provider.ts, which collects TFME's subscription fee:
 * different money, different credentials, different webhooks (spec: the two domains must never mix).
 *
 *   PaymentService (finance/online.ts)  ->  CustomerPaymentProvider  ->  PayFast / Peach / Yoco / ...
 *
 * Adding a provider = implement CustomerPaymentProvider and add it to PROVIDERS. Nothing else in invoices, payments,
 * UI, jobs or customers knows which provider is in use; they only see "online payments are/aren't configured".
 * Each business supplies its own credentials; they are stored encrypted and never leave the server.
 */

export interface CredentialField {
  key: string;
  label: string;
  /** Secret fields are write-only: the settings screen never shows them again. */
  secret: boolean;
  required: boolean;
}

export interface OnlineSessionRequest {
  /** Our payment id; echoed back by the provider and used to match the webhook. */
  paymentId: string;
  description: string;
  amountCents: number;
  payer: { name: string; email?: string | null };
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  sandbox: boolean;
  credentials: Record<string, string>;
}

/** Where the customer's browser is sent to pay. */
export interface OnlineSession {
  actionUrl: string;
  method: 'POST';
  fields: Record<string, string>;
}

export type OnlineStatus = 'COMPLETE' | 'FAILED' | 'CANCELLED' | 'PENDING';

/** A webhook after signature and provider-side verification. */
export interface VerifiedOnlinePayment {
  provider: string;
  /** Idempotency key: identical redeliveries produce the same value. */
  externalId: string;
  eventType: string;
  /** Our payment id (what we sent as the merchant reference). */
  paymentId: string;
  providerReference: string;
  amountCents: number;
  status: OnlineStatus;
  /** Sanitised copy for the event log (never secrets or card data). */
  payload: Record<string, string>;
}

export class ProviderVerificationError extends Error {}

export interface CustomerPaymentProvider {
  readonly key: string;
  readonly label: string;
  readonly credentialFields: CredentialField[];
  createSession(req: OnlineSessionRequest): OnlineSession;
  /** MUST throw ProviderVerificationError if the signature or provider-side confirmation fails. */
  verifyWebhook(rawBody: string, ctx: { credentials: Record<string, string>; sandbox: boolean; ip?: string }): Promise<VerifiedOnlinePayment>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ text(): Promise<string> }>;

/** PayFast (South Africa). Hosted checkout; the ITN (webhook) is verified by signature AND by asking PayFast to confirm it. */
export class PayFastCustomerProvider implements CustomerPaymentProvider {
  readonly key = 'payfast';
  readonly label = 'PayFast';
  readonly credentialFields: CredentialField[] = [
    { key: 'merchantId', label: 'Merchant ID', secret: false, required: true },
    { key: 'merchantKey', label: 'Merchant key', secret: true, required: true },
    { key: 'passphrase', label: 'Passphrase', secret: true, required: false },
  ];

  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  private host(sandbox: boolean) {
    return sandbox ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za';
  }

  createSession(req: OnlineSessionRequest): OnlineSession {
    const c = req.credentials;
    // Field ORDER matters: the signature is computed over the fields in this order.
    const ordered: [string, string][] = [
      ['merchant_id', c.merchantId ?? ''],
      ['merchant_key', c.merchantKey ?? ''],
      ['return_url', req.returnUrl],
      ['cancel_url', req.cancelUrl],
      ['notify_url', req.notifyUrl],
      ['name_first', req.payer.name.slice(0, 100)],
      ['email_address', req.payer.email ?? ''],
      ['m_payment_id', req.paymentId],
      ['amount', centsToDecimal(req.amountCents)],
      ['item_name', req.description.slice(0, 100)],
    ];
    const present = ordered.filter(([, v]) => v !== '');
    return {
      actionUrl: `${this.host(req.sandbox)}/eng/process`,
      method: 'POST',
      fields: { ...Object.fromEntries(present), signature: payfastSignature(present, c.passphrase) },
    };
  }

  async verifyWebhook(rawBody: string, ctx: { credentials: Record<string, string>; sandbox: boolean }): Promise<VerifiedOnlinePayment> {
    const entries = [...new URLSearchParams(rawBody).entries()];
    const received = entries.find(([k]) => k === 'signature')?.[1];
    const pairs = entries.filter(([k]) => k !== 'signature') as [string, string][];
    if (!received || pairs.length === 0) throw new ProviderVerificationError('missing signature');
    const passphrase = ctx.credentials.passphrase;
    const withBlanks = payfastSignature(pairs, passphrase);
    const withoutBlanks = payfastSignature(pairs.filter(([, v]) => v !== ''), passphrase);
    if (!safeEqual(received.toLowerCase(), withBlanks) && !safeEqual(received.toLowerCase(), withoutBlanks)) throw new ProviderVerificationError('bad signature');

    const data = Object.fromEntries(pairs);
    if (data.merchant_id !== ctx.credentials.merchantId) throw new ProviderVerificationError('merchant mismatch');

    // Server-to-server confirmation: the authoritative check. A forged or replayed-with-changes body fails here.
    const paramString = pairs.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join('&');
    const res = await this.fetchImpl(`${this.host(ctx.sandbox)}/eng/query/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: paramString,
    });
    if ((await res.text()).trim() !== 'VALID') throw new ProviderVerificationError('provider validation failed');

    const providerReference = data.pf_payment_id;
    const paymentId = data.m_payment_id;
    if (!providerReference || !paymentId) throw new ProviderVerificationError('missing identifiers');
    let amountCents: number;
    try {
      amountCents = parseDecimalToCents(data.amount_gross ?? '');
    } catch (err) {
      if (err instanceof MoneyError) throw new ProviderVerificationError('bad amount');
      throw err;
    }
    const raw = (data.payment_status ?? '').toUpperCase();
    const status: OnlineStatus = raw === 'COMPLETE' || raw === 'FAILED' || raw === 'CANCELLED' ? raw : 'PENDING';
    const { signature: _s, merchant_id: _m, merchant_key: _k, token: _t, ...payload } = data;
    void _s; void _m; void _k; void _t;
    return { provider: this.key, externalId: `${providerReference}:${status}`, eventType: `payment.${status.toLowerCase()}`, paymentId, providerReference, amountCents, status, payload };
  }
}

const PROVIDERS: Record<string, () => CustomerPaymentProvider> = {
  payfast: () => new PayFastCustomerProvider(),
};

const cache = new Map<string, CustomerPaymentProvider>();

export const providerKeys = () => Object.keys(PROVIDERS);

export function getCustomerProvider(key: string | null | undefined): CustomerPaymentProvider | null {
  if (!key) return null;
  const hit = cache.get(key);
  if (hit) return hit;
  const make = PROVIDERS[key];
  if (!make) return null;
  const p = make();
  cache.set(key, p);
  return p;
}

/** Tests substitute a provider (or restore the real one with undefined). */
export function setCustomerProviderForTests(key: string, p: CustomerPaymentProvider | undefined) {
  if (p) cache.set(key, p);
  else cache.delete(key);
}

/** Stable short fingerprint of a credentials object, for audit ("credentials changed") without logging them. */
export const credentialsFingerprint = (c: Record<string, string>) => createHash('sha256').update(JSON.stringify(Object.entries(c).sort())).digest('hex').slice(0, 12);
