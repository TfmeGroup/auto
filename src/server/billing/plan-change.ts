import { z } from 'zod';
import { prisma, withTenant, withTx, setTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { appUrl } from '@/lib/url';
import { vatOnExclusive } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { optionalText, parseOrThrow } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { billingContacts, emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { requirePermission } from '@/server/permissions/authorize';
import { measureUsage, type UsageNumbers } from '@/server/usage/service';
import type { BusinessContext } from '@/server/context';
import { PLATFORM_VAT_RATE_BPS } from './constants';
import { ALL_FEATURES, FEATURES, isFeatureKey, type FeatureKey } from './features';
import { getPaymentProvider, type CheckoutForm } from './provider';
import { scheduleProviderAmountUpdate, scheduleProviderCancel } from './provider-ops';
import { TRIAL_PLAN_KEY } from './plans';

export { PLATFORM_VAT_RATE_BPS };

export type ChangeMode = 'checkout' | 'scheduled_downgrade' | 'contact' | 'none';

export interface PlanChangeEvaluation {
  current: { key: string; name: string };
  target: {
    key: string;
    name: string;
    priceCents: number | null;
    vatCents: number | null;
    totalCents: number | null;
    interval: 'MONTHLY' | 'ANNUAL';
    limits: { members: number; locations: number; storageMb: number };
    features: FeatureKey[];
  };
  direction: 'upgrade' | 'downgrade' | 'same';
  mode: ChangeMode;
  limitChanges: { what: string; from: number; to: number }[];
  featuresGained: { key: FeatureKey; label: string }[];
  featuresLost: { key: FeatureKey; label: string }[];
  /** Usage that exceeds the target plan. Must be fixed before the change can happen. */
  violations: { kind: 'members' | 'locations' | 'storage'; used: number; limit: number; message: string }[];
  canProceed: boolean;
  /** Plain-language reason when canProceed is false. */
  reason: string | null;
  /** When a downgrade would take effect (end of the paid period). */
  effectiveAt: Date | null;
}

const PAID_LIVE = new Set(['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD']);
const MB = 1024 * 1024;

export function violationsFor(usage: UsageNumbers, limits: { members: number; locations: number; storageMb: number }) {
  const out: PlanChangeEvaluation['violations'] = [];
  if (usage.members > limits.members) {
    const n = usage.members - limits.members;
    out.push({ kind: 'members', used: usage.members, limit: limits.members, message: `You have ${usage.members} team members (including pending invitations) but this plan allows ${limits.members}. Suspend, remove or revoke ${n} first.` });
  }
  if (usage.locations > limits.locations) {
    out.push({ kind: 'locations', used: usage.locations, limit: limits.locations, message: `You have ${usage.locations} active locations but this plan allows ${limits.locations}. Archive ${usage.locations - limits.locations} first.` });
  }
  if (usage.storageBytes > limits.storageMb * MB) {
    out.push({ kind: 'storage', used: usage.storageBytes, limit: limits.storageMb * MB, message: `You are using ${(usage.storageBytes / MB).toFixed(0)} MB of storage but this plan includes ${limits.storageMb} MB. Free up space first.` });
  }
  return out;
}

/**
 * What would happen if this business moved to `targetKey`? Pure read — used by the
 * confirmation screen AND re-run by every mutating call, so the UI is never the authority.
 */
export async function evaluatePlanChange(ctx: BusinessContext, targetKey: string): Promise<PlanChangeEvaluation> {
  requirePermission(ctx, 'settings.manage_billing');
  const target = await prisma().plan.findUnique({ where: { key: targetKey }, include: { features: true } });
  if (!target || target.status !== 'ACTIVE' || !target.isPublic || target.key === TRIAL_PLAN_KEY) throw Errors.notFound('Plan');
  const sub = ctx.subscription;
  const current = await prisma().plan.findUnique({ where: { id: sub.planId ?? '' } });

  const targetFeatures = target.features.filter((f) => f.enabled).map((f) => f.featureKey).filter(isFeatureKey);
  const paidLive = PAID_LIVE.has(sub.status);
  const sameAsCurrent = paidLive && current?.key === target.key;
  const direction: PlanChangeEvaluation['direction'] = sameAsCurrent ? 'same' : !paidLive ? 'upgrade' : (target.sortOrder > (current?.sortOrder ?? 0) ? 'upgrade' : 'downgrade');

  const price = target.priceCents;
  const vat = price === null ? null : vatOnExclusive(price, PLATFORM_VAT_RATE_BPS);
  const limits = { members: target.maxMembers, locations: target.maxLocations, storageMb: target.maxStorageMb };
  const usage = await withTenant(ctx.business.id, (tx) => measureUsage(tx, ctx.business.id));
  const violations = violationsFor(usage, limits);

  const provider = getPaymentProvider();
  let mode: ChangeMode = direction === 'downgrade' ? 'scheduled_downgrade' : 'checkout';
  let reason: string | null = null;
  if (direction === 'same') { mode = 'none'; reason = 'You are already on this plan.'; }
  else if (target.isCustom) { mode = 'contact'; reason = 'Custom plans are arranged with our team. Contact us to set one up.'; }
  else if (price === null) { mode = 'none'; reason = 'Pricing for this plan has not been configured yet.'; }
  else if (sub.isCustom && direction === 'downgrade') { mode = 'contact'; reason = 'Moving off a Custom plan is arranged with our team.'; }
  else if (violations.length > 0) reason = violations.map((v) => v.message).join(' ');
  else if (mode === 'checkout' && !provider) reason = 'Online billing is not configured yet.';
  else if (mode === 'scheduled_downgrade') {
    if (!sub.providerSubscriptionRef || !sub.provider) reason = 'There is no recurring payment to change.';
    else if (!provider?.capabilities.updateAmount) reason = 'Your payment provider cannot change the amount automatically. Contact support to downgrade.';
    else if (sub.pendingPlanKey) reason = 'A plan change is already scheduled. Cancel it first.';
  }

  const gained = targetFeatures.filter((f) => !sub.features.has(f));
  const lost = [...sub.features].filter((f) => !targetFeatures.includes(f));
  const label = (k: FeatureKey) => ({ key: k, label: FEATURES[k] });

  return {
    current: { key: sub.planKey, name: sub.planName },
    target: { key: target.key, name: target.name, priceCents: price, vatCents: vat, totalCents: price === null || vat === null ? null : price + vat, interval: target.billingInterval, limits, features: ALL_FEATURES.filter((f) => targetFeatures.includes(f)) },
    direction,
    mode,
    limitChanges: [
      { what: 'Team members', from: sub.limits.members, to: limits.members },
      { what: 'Locations', from: sub.limits.locations, to: limits.locations },
      { what: 'Storage (MB)', from: sub.limits.storageMb, to: limits.storageMb },
    ],
    featuresGained: gained.map(label),
    featuresLost: lost.map(label),
    violations,
    canProceed: reason === null,
    reason,
    effectiveAt: direction === 'downgrade' ? sub.currentPeriodEnd : null,
  };
}

/**
 * Begin a plan purchase or upgrade. Re-evaluates everything server-side, creates a
 * PENDING payment record that WE own, and returns the provider's signed checkout form.
 * The subscription changes only when the provider's verified webhook arrives.
 */
export async function startCheckout(ctx: BusinessContext, planKey: string): Promise<CheckoutForm> {
  const ev = await evaluatePlanChange(ctx, planKey);
  if (ev.mode !== 'checkout' || !ev.canProceed || ev.target.totalCents === null) {
    throw Errors.badRequest(ev.reason ?? 'This plan change is not available.');
  }
  const provider = getPaymentProvider()!;
  const plan = await prisma().plan.findUniqueOrThrow({ where: { key: planKey } });
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });

  const payment = await withTx(async (tx) => {
    await setTenant(tx, ctx.business.id);
    const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: ctx.business.id } });
    const p = await tx.subscriptionPayment.create({
      data: { businessId: ctx.business.id, subscriptionId: sub.id, planId: plan.id, provider: provider.name, amountCents: ev.target.totalCents!, status: 'PENDING' },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.checkoutStarted,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'subscription',
      resourceId: sub.id,
      metadata: { planKey: plan.key, amountCents: ev.target.totalCents, paymentId: p.id },
    });
    return p;
  });

  return provider.createCheckout({
    paymentId: payment.id,
    itemName: `TFME Auto ${plan.name}`,
    amountCents: ev.target.totalCents,
    payer: { name: user.name, email: user.email },
    returnUrl: appUrl('/settings/billing?checkout=return'),
    cancelUrl: appUrl('/settings/billing?checkout=cancelled'),
    notifyUrl: appUrl(`/api/webhooks/${provider.name}`),
  });
}

// ─────────────── downgrade ───────────────

/**
 * Downgrade at the end of the paid period (the customer keeps what they paid for). Usage is
 * validated NOW; the lower amount is pushed to the provider so the next renewal charges the
 * right price; the plan itself switches when the period ends (see the scheduler).
 */
export async function scheduleDowngrade(ctx: BusinessContext, planKey: string) {
  const ev = await evaluatePlanChange(ctx, planKey);
  if (ev.mode !== 'scheduled_downgrade' || !ev.canProceed || ev.target.totalCents === null) {
    throw Errors.badRequest(ev.reason ?? 'This downgrade is not available.');
  }
  const target = await prisma().plan.findUniqueOrThrow({ where: { key: planKey } });
  await withTenant(ctx.business.id, async (tx) => {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: ctx.business.id } });
    if (!sub.currentPeriodEnd) throw Errors.badRequest('There is no paid period to downgrade from.');
    await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: target.id, pendingChangeAt: sub.currentPeriodEnd } });
    await scheduleProviderAmountUpdate(tx, { businessId: ctx.business.id, provider: sub.provider!, ref: sub.providerSubscriptionRef!, amountCents: ev.target.totalCents!, subscriptionId: sub.id });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.downgradeScheduled,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'subscription',
      resourceId: sub.id,
      before: { plan: ctx.subscription.planKey },
      after: { pendingPlan: target.key, effectiveAt: sub.currentPeriodEnd },
    });
    const when = formatDate(sub.currentPeriodEnd, ctx.business.timezone, ctx.business.locale);
    for (const c of await billingContacts(tx, ctx.business.id)) {
      await emailUser(tx, c, 'billing', (to, name) => templates.subscriptionChanged(to, name, ctx.business.name, `${ctx.user.name} scheduled a change from ${ctx.subscription.planName} to ${target.name}, effective ${when}. You keep your current plan until then.`));
    }
  });
  return { effectiveAt: ev.effectiveAt };
}

export async function cancelScheduledDowngrade(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.manage_billing');
  await withTenant(ctx.business.id, async (tx) => {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: ctx.business.id }, include: { plan: true } });
    if (!sub.pendingPlanId) throw Errors.conflict('No plan change is scheduled.');
    await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null, pendingChangeAt: null } });
    // Put the provider back on the current plan's price.
    if (sub.provider && sub.providerSubscriptionRef && sub.plan.priceCents !== null) {
      const back = sub.plan.priceCents + vatOnExclusive(sub.plan.priceCents, PLATFORM_VAT_RATE_BPS);
      await scheduleProviderAmountUpdate(tx, { businessId: ctx.business.id, provider: sub.provider, ref: sub.providerSubscriptionRef, amountCents: back, subscriptionId: sub.id });
    }
    await recordAudit(tx, ctx.meta, { action: AuditActions.downgradeCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'subscription', resourceId: sub.id });
  });
}

// ─────────────── cancellation ───────────────

export const cancelSchema = z.object({ reason: optionalText(500), confirm: z.literal(true, { message: 'Please confirm the cancellation' }) });

/**
 * Cancel the paid subscription. Access continues until the paid-through date; the business
 * and its data are never deleted. The provider's recurring billing is stopped by a retried
 * background job.
 */
export async function cancelSubscription(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.manage_billing');
  const data = parseOrThrow(cancelSchema, input);
  const s = ctx.subscription;
  if (!PAID_LIVE.has(s.status)) throw Errors.conflict(s.status === 'CANCELED' ? 'This subscription is already cancelled.' : 'There is no paid subscription to cancel.');

  return withTenant(ctx.business.id, async (tx) => {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: ctx.business.id } });
    await tx.subscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELED', cancelAtPeriodEnd: true, canceledAt: new Date(), canceledById: ctx.user.id, cancelReason: data.reason ?? null, pendingPlanId: null, pendingChangeAt: null },
    });
    if (sub.provider && sub.providerSubscriptionRef) {
      await scheduleProviderCancel(tx, { businessId: ctx.business.id, provider: sub.provider, ref: sub.providerSubscriptionRef });
    }
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.subscriptionCancelled,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'subscription',
      resourceId: sub.id,
      before: { status: s.status },
      after: { status: 'CANCELED', accessUntil: sub.currentPeriodEnd },
      metadata: { reason: data.reason ?? null, by: 'customer' },
    });
    const endsOn = sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd, ctx.business.timezone, ctx.business.locale) : 'today';
    for (const c of await billingContacts(tx, ctx.business.id)) await emailUser(tx, c, 'billing', (to, name) => templates.cancellation(to, name, ctx.business.name, endsOn));
    return { accessUntil: sub.currentPeriodEnd };
  });
}
