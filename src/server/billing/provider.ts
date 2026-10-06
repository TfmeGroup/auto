import { env } from '@/lib/env';
import { PayFastProvider } from './payfast';

/**
 * Payment provider integration boundary. Everything provider-specific (field names,
 * signatures, endpoints) lives behind this interface so the subscription logic never
 * depends on a particular gateway. Adding Peach Payments, Yoco, etc. means writing one
 * class that implements PaymentProvider and registering it in PROVIDERS below — see
 * docs/BILLING.md. Providers differ, so each declares what it can do (`capabilities`)
 * and the billing code adapts instead of assuming.
 */

export interface CheckoutRequest {
  /** Our SubscriptionPayment id; echoed back by the provider and used to match the webhook. */
  paymentId: string;
  itemName: string;
  /** Amount charged per period, VAT-inclusive, in cents. */
  amountCents: number;
  payer: { name: string; email: string };
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
}

export interface CheckoutForm {
  /** Where the browser must POST the fields. */
  actionUrl: string;
  fields: Record<string, string>;
}

export type ProviderPaymentStatus = 'COMPLETE' | 'FAILED' | 'CANCELLED' | 'PENDING';

/** A webhook after signature (and, where supported, provider-side) verification. */
export interface VerifiedWebhook {
  provider: string;
  /** Idempotency key: identical redeliveries produce the same value. */
  externalId: string;
  eventType: string;
  /** Our SubscriptionPayment id. */
  paymentId: string;
  providerPaymentId: string;
  amountCents: number;
  status: ProviderPaymentStatus;
  /** Provider's recurring-billing token, when present. */
  subscriptionRef?: string;
  /** Display-only payment method summary, if the provider reports one (never card data). */
  paymentMethodSummary?: string;
  /** Sanitised copy for the event log (no secrets). */
  payload: Record<string, string>;
}

export class WebhookVerificationError extends Error {}

export interface ProviderCapabilities {
  /** Can end a recurring subscription via API. */
  cancelSubscription: boolean;
  /** Can change the recurring amount of an existing subscription via API (needed for downgrades). */
  updateAmount: boolean;
}

export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  createCheckout(req: CheckoutRequest): CheckoutForm;
  /**
   * Verify an inbound webhook and normalise it. MUST throw
   * WebhookVerificationError if the signature or provider-side validation fails.
   */
  verifyWebhook(rawBody: string, ctx: { ip?: string }): Promise<VerifiedWebhook>;
  cancelSubscription?(ref: string): Promise<void>;
  updateAmount?(ref: string, amountCents: number): Promise<void>;
}

/** Provider registry: name -> factory. Selecting the active provider is configuration (BILLING_PROVIDER). */
const PROVIDERS: Record<string, () => PaymentProvider> = {
  payfast: () => new PayFastProvider(),
};

let provider: PaymentProvider | null | undefined;

/** The provider checkouts go through, or null when online billing is not configured. */
export function getPaymentProvider(): PaymentProvider | null {
  if (provider !== undefined) return provider;
  const name = env().BILLING_PROVIDER;
  provider = name === 'none' ? null : (PROVIDERS[name]?.() ?? null);
  return provider;
}

/** Resolve a provider by name for webhooks/jobs. Only the configured provider is accepted. */
export function getPaymentProviderByName(name: string): PaymentProvider | null {
  const p = getPaymentProvider();
  return p && p.name === name ? p : null;
}

export function setPaymentProviderForTests(p: PaymentProvider | null | undefined) {
  provider = p;
}
