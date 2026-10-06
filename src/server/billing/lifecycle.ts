import { prisma, withTenant } from '@/server/db/client';
import { appUrl } from '@/lib/url';
import { formatDate } from '@/lib/format';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { systemMeta } from '@/server/context';
import { billingContacts, billingInApp, emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { getPlatformSettings } from '@/server/settings/platform';
import { deriveStatus, RENEWAL_TOLERANCE_MS, type SubStatus } from './state-machine';

/**
 * Time-driven billing transitions. Each function is IDEMPOTENT (guarded updates + dedupe keys at
 * the enqueue site), so the scheduler can run as often as it likes, on any number of instances.
 * Effective access never depends on these having run (see state-machine.ts) — they exist to keep
 * stored state tidy, write the audit trail, and send the right email exactly once.
 */

const DAY = 86_400_000;
const billingUrl = () => appUrl('/settings/billing');

async function load(subscriptionId: string) {
  return prisma().subscription.findUnique({ where: { id: subscriptionId }, include: { business: true, plan: true } });
}

export async function runTrialReminder(p: { subscriptionId: string; day: number }) {
  const sub = await load(p.subscriptionId);
  if (!sub || sub.status !== 'TRIALING' || sub.convertedAt || !sub.trialEndsAt || sub.trialEndsAt <= new Date()) return;
  if (sub.business.status !== 'ACTIVE') return;
  const left = Math.max(1, Math.ceil((sub.trialEndsAt.getTime() - Date.now()) / DAY));
  for (const c of await billingContacts(prisma(), sub.businessId)) {
    await emailUser(prisma(), c, 'trial_reminders', (to, name) => templates.trialReminder(to, name, sub.business.name, left, billingUrl()));
  }
  await billingInApp(sub.businessId, 'TRIAL_ENDING', `${left} day${left === 1 ? '' : 's'} left in your free trial`, 'Choose a plan to keep using TFME Auto without interruption. Nothing is deleted if you do not.');
}

export async function runTrialExpired(p: { subscriptionId: string }) {
  const sub = await load(p.subscriptionId);
  if (!sub) return;
  const moved = await prisma().subscription.updateMany({
    where: { id: sub.id, status: 'TRIALING', trialEndsAt: { lte: new Date() } },
    data: { status: 'EXPIRED' },
  });
  if (moved.count !== 1) return; // converted in the meantime, or already handled
  await withTenant(sub.businessId, async (tx) => {
    await recordAudit(tx, systemMeta('scheduler'), {
      action: AuditActions.trialExpired,
      businessId: sub.businessId,
      resourceType: 'subscription',
      resourceId: sub.id,
      before: { status: 'TRIALING' },
      after: { status: 'EXPIRED' },
    });
    if (sub.business.status === 'ACTIVE') {
      for (const c of await billingContacts(tx, sub.businessId)) await emailUser(tx, c, 'billing', (to, name) => templates.trialExpired(to, name, sub.business.name, billingUrl()));
      await billingInApp(sub.businessId, 'SUBSCRIPTION_STATUS_CHANGED', 'Your free trial has ended', 'The business is now read-only. Your data is safe. Choose a plan to continue.');
    }
  });
}

const PHASE_STATUS: Record<'past_due' | 'grace' | 'suspended', SubStatus> = { past_due: 'PAST_DUE', grace: 'GRACE_PERIOD', suspended: 'SUSPENDED' };

/** Record that a business entered a new delinquency phase (stored status, audit, one email). */
export async function runDelinquencyPhase(p: { subscriptionId: string; phase: 'past_due' | 'grace' | 'suspended' }) {
  const sub = await load(p.subscriptionId);
  if (!sub || sub.business.status !== 'ACTIVE') return;
  const settings = await getPlatformSettings();
  const derived = deriveStatus(sub, new Date(), settings);
  const target = PHASE_STATUS[p.phase];
  // Only record phases that actually apply now (a payment may have arrived since the job was queued).
  if (!['PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED'].includes(derived)) return;
  const status = derived; // never record a phase later than reality, nor an earlier one than already stored
  if (sub.status === status) return;
  const since = sub.pastDueSince ?? (sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd.getTime() + RENEWAL_TOLERANCE_MS) : new Date());
  await prisma().subscription.update({ where: { id: sub.id }, data: { status, pastDueSince: sub.pastDueSince ?? since } });

  await withTenant(sub.businessId, async (tx) => {
    await recordAudit(tx, systemMeta('scheduler'), {
      action: status === 'SUSPENDED' ? AuditActions.subscriptionSuspended : status === 'GRACE_PERIOD' ? AuditActions.subscriptionGrace : AuditActions.subscriptionPastDue,
      businessId: sub.businessId,
      resourceType: 'subscription',
      resourceId: sub.id,
      before: { status: sub.status },
      after: { status },
      metadata: { requestedPhase: target },
    });
    const graceLeft = Math.max(1, Math.ceil((since.getTime() + (settings.pastDueRetryDays + settings.graceDays) * DAY - Date.now()) / DAY));
    for (const c of await billingContacts(tx, sub.businessId)) {
      await emailUser(tx, c, 'billing', (to, name) =>
        status === 'SUSPENDED' ? templates.suspended(to, name, sub.business.name, billingUrl())
        : status === 'GRACE_PERIOD' ? templates.gracePeriod(to, name, sub.business.name, billingUrl(), graceLeft)
        : templates.paymentFailed(to, name, sub.business.name, billingUrl(), `Your last payment is overdue. Please update your billing details.`));
    }
    await billingInApp(sub.businessId, status === 'PAST_DUE' ? 'SUBSCRIPTION_PAYMENT_FAILED' : 'SUBSCRIPTION_STATUS_CHANGED', status === 'SUSPENDED' ? 'Your subscription is suspended' : status === 'GRACE_PERIOD' ? 'Your subscription is in its grace period' : 'A subscription payment is overdue', status === 'SUSPENDED' ? 'The business is read-only until payment is made. Your data is safe.' : 'Please update your billing details to avoid interruption.');
  });
}

export async function runSubscriptionExpired(p: { subscriptionId: string }) {
  const sub = await load(p.subscriptionId);
  if (!sub) return;
  const moved = await prisma().subscription.updateMany({
    where: { id: sub.id, status: 'CANCELED', currentPeriodEnd: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
  if (moved.count !== 1) return;
  await withTenant(sub.businessId, (tx) =>
    recordAudit(tx, systemMeta('scheduler'), { action: AuditActions.subscriptionExpired, businessId: sub.businessId, resourceType: 'subscription', resourceId: sub.id, before: { status: 'CANCELED' }, after: { status: 'EXPIRED' } }),
  );
}

/** Switch plans for scheduled downgrades whose paid period has ended. Safe to call repeatedly. */
export async function applyDuePlanChanges(now = new Date()): Promise<number> {
  const due = await prisma().subscription.findMany({
    where: { pendingPlanId: { not: null }, pendingChangeAt: { lte: now }, status: { in: ['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'] } },
    include: { plan: true, pendingPlan: true, business: true },
  });
  let applied = 0;
  for (const sub of due) {
    if (!sub.pendingPlan) continue;
    const moved = await prisma().subscription.updateMany({
      where: { id: sub.id, pendingPlanId: sub.pendingPlanId },
      data: { planId: sub.pendingPlanId!, pendingPlanId: null, pendingChangeAt: null },
    });
    if (moved.count !== 1) continue;
    applied++;
    await withTenant(sub.businessId, async (tx) => {
      await recordAudit(tx, systemMeta('scheduler'), {
        action: AuditActions.planChanged,
        businessId: sub.businessId,
        resourceType: 'subscription',
        resourceId: sub.id,
        before: { plan: sub.plan.key },
        after: { plan: sub.pendingPlan!.key },
        metadata: { scheduledDowngrade: true },
      });
      for (const c of await billingContacts(tx, sub.businessId)) {
        await emailUser(tx, c, 'billing', (to, name) => templates.subscriptionChanged(to, name, sub.business.name, `${sub.business.name} is now on the ${sub.pendingPlan!.name} plan (${formatDate(now, sub.business.timezone, sub.business.locale)}).`));
      }
    });
  }
  return applied;
}
