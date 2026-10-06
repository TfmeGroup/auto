import { Prisma, prisma, withTx, isUuid, setTenant, type Tx } from '@/server/db/client';
import { logger } from '@/lib/logger';
import { appUrl } from '@/lib/url';
import { formatMoney, vatFromInclusive } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { systemMeta } from '@/server/context';
import { billingContacts, billingInApp, emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { getPlatformSettings } from '@/server/settings/platform';
import { INVOICE_PREFIX, PLATFORM_VAT_RATE_BPS } from './constants';
import { scheduleProviderCancel } from './provider-ops';
import { WebhookVerificationError, type PaymentProvider, type VerifiedWebhook } from './provider';
import { applyEvent, type SubState } from './state-machine';

export type WebhookOutcome =
  | { result: 'processed' }
  | { result: 'duplicate' }
  | { result: 'ignored'; reason: string }
  | { result: 'rejected' };

function addInterval(from: Date, interval: 'MONTHLY' | 'ANNUAL'): Date {
  const d = new Date(from);
  if (interval === 'ANNUAL') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/**
 * Handle one inbound payment webhook, safely and idempotently.
 *
 *  1. Verify authenticity via the provider (signature + provider confirmation).
 *     Failures are rejected and never touch billing state.
 *  2. Store the event under (provider, externalId). A redelivery finds the same
 *     row and, if already PROCESSED, does nothing.
 *  3. Process inside one transaction holding a row lock on the event, so two
 *     concurrent deliveries cannot both apply it.
 *  4. Failures roll back and mark the event FAILED so the provider's retry is
 *     processed again (an event is only ever "done" once PROCESSED).
 *
 * Payment state changes ONLY here, from verified provider data matched to a
 * payment record we created ourselves — never from anything the browser says.
 */
export async function handleWebhook(provider: PaymentProvider, rawBody: string, ctx: { ip?: string }): Promise<WebhookOutcome> {
  let event: VerifiedWebhook;
  try {
    event = await provider.verifyWebhook(rawBody, ctx);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      logger.warn({ provider: provider.name, reason: err.message, ip: ctx.ip }, 'webhook rejected');
      return { result: 'rejected' };
    }
    throw err;
  }

  await prisma().webhookEvent.createMany({
    data: [{
      provider: event.provider,
      externalId: event.externalId,
      eventType: event.eventType,
      payload: event.payload as Prisma.InputJsonValue,
      signatureValid: true,
    }],
    skipDuplicates: true,
  });

  try {
    return await withTx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM webhook_events
        WHERE provider = ${event.provider} AND external_id = ${event.externalId}
        FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error('webhook event vanished');
      if (row.status === 'PROCESSED' || row.status === 'IGNORED') return { result: 'duplicate' } as const;

      const outcome = await applyPaymentEvent(tx, event);
      await tx.webhookEvent.update({
        where: { id: row.id },
        data: {
          status: outcome.result === 'processed' ? 'PROCESSED' : 'IGNORED',
          error: outcome.result === 'ignored' ? outcome.reason : null,
          processedAt: new Date(),
        },
      });
      return outcome;
    });
  } catch (err) {
    await prisma()
      .webhookEvent.update({
        where: { provider_externalId: { provider: event.provider, externalId: event.externalId } },
        data: { status: 'FAILED', error: String(err instanceof Error ? err.message : err).slice(0, 500) },
      })
      .catch(() => {});
    throw err; // route answers 5xx so the provider retries
  }
}

async function nextInvoiceNumber(tx: Tx): Promise<string> {
  const r = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('subscription_invoice_seq') AS n`;
  return `${INVOICE_PREFIX}${String(r[0]!.n).padStart(6, '0')}`;
}

async function applyPaymentEvent(tx: Tx, e: VerifiedWebhook): Promise<WebhookOutcome> {
  if (!isUuid(e.paymentId)) return { result: 'ignored', reason: 'unknown payment reference' };
  const payment = await tx.subscriptionPayment.findUnique({ where: { id: e.paymentId } });
  if (!payment) return { result: 'ignored', reason: 'unknown payment reference' };

  // Audit rows are tenant-scoped, so act within the paying business's context.
  await setTenant(tx, payment.businessId);

  const sub = await tx.subscription.findUniqueOrThrow({
    where: { id: payment.subscriptionId },
    include: { plan: true, pendingPlan: true },
  });
  const business = await tx.business.findUniqueOrThrow({ where: { id: payment.businessId } });
  const now = new Date();
  const meta = systemMeta(`webhook:${e.provider}`);
  const isInitial = payment.status === 'PENDING' && !payment.providerPaymentId;

  // The amount must match what WE asked the customer to pay: the checkout amount for a first/upgrade
  // payment, the subscription's current recurring amount for renewals. Never trust the payload alone.
  const expected = isInitial ? payment.amountCents : (sub.recurringAmountCents ?? payment.amountCents);
  if (e.amountCents !== expected) {
    logger.error({ paymentId: payment.id, expected, got: e.amountCents }, 'webhook amount mismatch');
    return { result: 'ignored', reason: 'amount mismatch' };
  }

  const state: SubState = { status: sub.status, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, pastDueSince: sub.pastDueSince, convertedAt: sub.convertedAt };
  const contacts = await billingContacts(tx, business.id);
  const billingUrl = appUrl('/settings/billing');

  switch (e.status) {
    case 'COMPLETE': {
      // Which plan does this payment put the business on?
      const dueDowngrade = !isInitial && sub.pendingPlan && sub.pendingChangeAt && sub.pendingChangeAt <= now;
      const plan = isInitial ? await tx.plan.findUniqueOrThrow({ where: { id: payment.planId } }) : dueDowngrade ? sub.pendingPlan! : sub.plan;

      let paymentRowId = payment.id;
      if (isInitial) {
        await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'COMPLETE', providerPaymentId: e.providerPaymentId } });
      } else if (payment.providerPaymentId !== e.providerPaymentId) {
        const made = await tx.subscriptionPayment.createManyAndReturn({
          data: [{ businessId: payment.businessId, subscriptionId: payment.subscriptionId, planId: plan.id, provider: payment.provider, providerPaymentId: e.providerPaymentId, amountCents: e.amountCents, status: 'COMPLETE' }],
          skipDuplicates: true,
        });
        if (made[0]) paymentRowId = made[0].id;
      }

      // Extend from the end of the current paid period if it is still in the future.
      const base = sub.currentPeriodEnd && sub.currentPeriodEnd > now && sub.status !== 'TRIALING' ? sub.currentPeriodEnd : now;
      const periodEnd = addInterval(base, plan.billingInterval);
      const patch = applyEvent(state, { type: 'PAYMENT_SUCCEEDED', periodEnd }, now);
      const before = { status: sub.status, plan: sub.plan.key, currentPeriodEnd: sub.currentPeriodEnd };

      // An upgrade creates a NEW provider subscription: end the old one so they are never billed twice.
      const replacedRef = isInitial && sub.providerSubscriptionRef && e.subscriptionRef && sub.providerSubscriptionRef !== e.subscriptionRef ? sub.providerSubscriptionRef : null;
      if (replacedRef && sub.provider) await scheduleProviderCancel(tx, { businessId: business.id, provider: sub.provider, ref: replacedRef });

      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: patch.status,
          pastDueSince: patch.pastDueSince,
          convertedAt: patch.convertedAt ?? sub.convertedAt,
          planId: plan.id,
          trialEndsAt: null,
          currentPeriodStart: base === now ? now : sub.currentPeriodEnd,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          cancelReason: null,
          pendingPlanId: isInitial || dueDowngrade ? null : sub.pendingPlanId,
          pendingChangeAt: isInitial || dueDowngrade ? null : sub.pendingChangeAt,
          recurringAmountCents: isInitial ? payment.amountCents : (dueDowngrade ? e.amountCents : sub.recurringAmountCents),
          provider: e.provider,
          providerSubscriptionRef: e.subscriptionRef ?? sub.providerSubscriptionRef,
          paymentMethodSummary: e.paymentMethodSummary ?? sub.paymentMethodSummary,
        },
      });

      // Tax invoice for this payment (one per provider payment, ever).
      const existingInvoice = await tx.subscriptionInvoice.findUnique({ where: { paymentId: paymentRowId } });
      let invoiceNumber = existingInvoice?.number;
      if (!existingInvoice) {
        const vat = vatFromInclusive(e.amountCents, PLATFORM_VAT_RATE_BPS);
        invoiceNumber = await nextInvoiceNumber(tx);
        await tx.subscriptionInvoice.create({
          data: {
            businessId: business.id,
            subscriptionId: sub.id,
            paymentId: paymentRowId,
            number: invoiceNumber,
            planName: plan.name,
            description: `TFME Auto ${plan.name} subscription (${plan.billingInterval === 'ANNUAL' ? 'annual' : 'monthly'})`,
            subtotalCents: e.amountCents - vat,
            vatCents: vat,
            totalCents: e.amountCents,
            vatRateBps: PLATFORM_VAT_RATE_BPS,
            currency: business.currency,
          },
        });
        await recordAudit(tx, meta, { action: AuditActions.invoiceIssued, businessId: business.id, resourceType: 'subscription_invoice', resourceId: paymentRowId, metadata: { number: invoiceNumber } });
      }

      await recordAudit(tx, meta, {
        action: AuditActions.paymentReceived,
        businessId: business.id,
        resourceType: 'subscription',
        resourceId: sub.id,
        metadata: { provider: e.provider, providerPaymentId: e.providerPaymentId, amountCents: e.amountCents, paymentId: paymentRowId },
      });
      await recordAudit(tx, meta, {
        action: sub.planId !== updated.planId ? AuditActions.planChanged : AuditActions.subscriptionChanged,
        businessId: business.id,
        resourceType: 'subscription',
        resourceId: sub.id,
        before,
        after: { status: updated.status, plan: plan.key, currentPeriodEnd: updated.currentPeriodEnd },
        metadata: { converted: !sub.convertedAt && !!updated.convertedAt, replacedProviderSubscription: !!replacedRef },
      });
      const amountText = formatMoney(e.amountCents, business.currency, business.locale);
      for (const c of contacts) await emailUser(tx, c, 'billing', (to, name) => templates.paymentSucceeded(to, name, business.name, amountText, invoiceNumber!));
      return { result: 'processed' };
    }

    case 'FAILED': {
      // A failed CHECKOUT (first payment / upgrade attempt) never degrades an existing subscription;
      // only a failed renewal starts the past-due clock.
      const patch = isInitial ? { changed: false as const, status: undefined, pastDueSince: undefined } : applyEvent(state, { type: 'PAYMENT_FAILED' }, now);
      if (isInitial) await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
      await recordAudit(tx, meta, { action: AuditActions.paymentFailed, businessId: business.id, resourceType: 'subscription', resourceId: sub.id, metadata: { provider: e.provider, providerPaymentId: e.providerPaymentId, amountCents: e.amountCents, firstPayment: isInitial } });
      if (patch.changed || isInitial) {
        if (patch.status) {
          await tx.subscription.update({ where: { id: sub.id }, data: { status: patch.status, pastDueSince: patch.pastDueSince } });
          await recordAudit(tx, meta, { action: AuditActions.subscriptionChanged, businessId: business.id, resourceType: 'subscription', resourceId: sub.id, before: { status: sub.status }, after: { status: patch.status }, metadata: { reason: 'payment failed' } });
        }
        const s = await getPlatformSettings();
        const detail = patch.status
          ? `We will keep retrying for ${s.pastDueRetryDays} days, followed by a ${s.graceDays}-day grace period. Please update your payment details with your payment provider.`
          : 'Please try again, or choose a different payment method.';
        for (const c of contacts) await emailUser(tx, c, 'billing', (to, name) => templates.paymentFailed(to, name, business.name, billingUrl, detail));
        await billingInApp(business.id, 'SUBSCRIPTION_PAYMENT_FAILED', 'A subscription payment did not go through', detail);
      }
      return { result: 'processed' };
    }

    case 'CANCELLED': {
      const patch = applyEvent(state, { type: 'CANCELLED_BY_PROVIDER' }, now);
      if (patch.status) {
        await tx.subscription.update({ where: { id: sub.id }, data: { status: patch.status, cancelAtPeriodEnd: true, canceledAt: sub.canceledAt ?? now } });
        await recordAudit(tx, meta, { action: AuditActions.subscriptionCancelled, businessId: business.id, resourceType: 'subscription', resourceId: sub.id, before: { status: sub.status }, after: { status: patch.status }, metadata: { by: 'provider' } });
        const endsOn = sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd, business.timezone, business.locale) : 'the end of the current period';
        for (const c of contacts) await emailUser(tx, c, 'billing', (to, name) => templates.cancellation(to, name, business.name, endsOn));
      }
      return { result: 'processed' };
    }

    default:
      return { result: 'ignored', reason: 'pending status carries no state change' };
  }
}
