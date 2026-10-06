import { prisma, type Db } from '@/server/db/client';
import { enqueue } from '@/server/jobs/queue';
import { JobTypes } from '@/server/jobs/types';
import { logger } from '@/lib/logger';
import { getPaymentProviderByName } from './provider';

/**
 * Calls to the payment provider that change state on THEIR side (cancel a recurring
 * subscription, change its amount) run as background jobs, enqueued inside the same
 * database transaction as our own change. That gives: no slow external call blocking a
 * request, automatic retries with backoff, and exactly-once enqueueing (dedupe keys).
 */

export async function scheduleProviderCancel(db: Db, a: { businessId: string; provider: string; ref: string }) {
  await enqueue(db, JobTypes.providerCancel, { provider: a.provider, ref: a.ref }, { dedupeKey: `provider-cancel:${a.provider}:${a.ref}`, businessId: a.businessId });
}

export async function scheduleProviderAmountUpdate(
  db: Db,
  a: { businessId: string; provider: string; ref: string; amountCents: number; subscriptionId: string },
) {
  await enqueue(
    db,
    JobTypes.providerUpdateAmount,
    { provider: a.provider, ref: a.ref, amountCents: a.amountCents, subscriptionId: a.subscriptionId },
    { dedupeKey: `provider-amount:${a.provider}:${a.ref}:${a.amountCents}:${Date.now()}`, businessId: a.businessId },
  );
}

export async function runProviderCancel(p: { provider: string; ref: string }): Promise<void> {
  const provider = getPaymentProviderByName(p.provider);
  if (!provider?.cancelSubscription) {
    // Nothing the platform can do automatically: surface loudly for an operator, don't retry forever.
    logger.error({ provider: p.provider, ref: p.ref }, 'provider cannot cancel subscriptions via API: cancel it manually at the provider');
    return;
  }
  await provider.cancelSubscription(p.ref);
}

/**
 * Change the recurring amount at the provider. Only AFTER the provider confirms do we record it
 * as the amount renewals will be validated against, so our records never run ahead of reality.
 */
export async function runProviderAmountUpdate(p: { provider: string; ref: string; amountCents: number; subscriptionId: string }): Promise<void> {
  const provider = getPaymentProviderByName(p.provider);
  if (!provider?.updateAmount) throw new Error(`provider ${p.provider} cannot change subscription amounts via API`);
  await provider.updateAmount(p.ref, p.amountCents);
  await prisma().subscription.update({ where: { id: p.subscriptionId }, data: { recurringAmountCents: p.amountCents } });
}
