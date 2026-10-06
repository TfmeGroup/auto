import { env } from '@/lib/env';
import { Errors } from '@/lib/errors';
import type { Db, Tx } from '@/server/db/client';
import { getPlatformSettings } from '@/server/settings/platform';
import { isFeatureKey, type FeatureKey } from './features';
import { TRIAL_PLAN_KEY } from './plans';
import { canWriteIn, daysRemaining, deriveStatus, trialPhase, type SubStatus, type TrialPhase } from './state-machine';


const DAY = 86_400_000;

export type EffectiveStatus = SubStatus;

export interface PlanLimits {
  members: number;
  locations: number;
  storageMb: number;
}

export interface EffectiveSubscription {
  subscriptionId: string | null;
  status: EffectiveStatus;
  planId: string | null;
  planKey: string;
  planName: string;
  isCustom: boolean;
  /** Limits that apply right now (contract overrides applied, and any scheduled downgrade's lower limits). */
  limits: PlanLimits;
  features: ReadonlySet<FeatureKey>;
  billingInterval: 'MONTHLY' | 'ANNUAL';
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialDaysRemaining: number | null;
  trialPhase: TrialPhase;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelReason: string | null;
  pastDueSince: Date | null;
  pendingPlanKey: string | null;
  pendingChangeAt: Date | null;
  provider: string | null;
  providerSubscriptionRef: string | null;
  paymentMethodSummary: string | null;
  /** Whether the business may create/change data. Expired/suspended = read-only; data stays safe and visible. */
  canWrite: boolean;
}

const EMPTY: EffectiveSubscription = {
  subscriptionId: null,
  status: 'EXPIRED',
  planId: null,
  planKey: 'none',
  planName: 'No plan',
  isCustom: false,
  limits: { members: 0, locations: 0, storageMb: 0 },
  features: new Set(),
  billingInterval: 'MONTHLY',
  trialStartedAt: null,
  trialEndsAt: null,
  trialDaysRemaining: null,
  trialPhase: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  cancelReason: null,
  pastDueSince: null,
  pendingPlanKey: null,
  pendingChangeAt: null,
  provider: null,
  providerSubscriptionRef: null,
  paymentMethodSummary: null,
  canWrite: false,
};

/** Backwards-compatible helper used by older call sites/tests. */
export function effectiveStatus(
  sub: Parameters<typeof deriveStatus>[0],
  now = new Date(),
  settings: Parameters<typeof deriveStatus>[2] = { pastDueRetryDays: 3, graceDays: 7 },
): EffectiveStatus {
  return deriveStatus(sub, now, settings);
}

export async function loadEffectiveSubscription(db: Db, businessId: string, now = new Date()): Promise<EffectiveSubscription> {
  const sub = await db.subscription.findUnique({
    where: { businessId },
    include: { plan: { include: { features: true } }, pendingPlan: true },
  });
  if (!sub) return EMPTY; // no subscription row: fail closed (read-only, no features)

  const settings = await getPlatformSettings();
  const status = deriveStatus(sub, now, settings);

  // Contract overrides apply to the current plan.
  const limits: PlanLimits = {
    members: sub.overrideMaxMembers ?? sub.plan.maxMembers,
    locations: sub.overrideMaxLocations ?? sub.plan.maxLocations,
    storageMb: sub.overrideMaxStorageMb ?? sub.plan.maxStorageMb,
  };
  // While a downgrade is scheduled, never let usage grow past what the lower plan allows,
  // or the downgrade could become impossible to apply.
  if (sub.pendingPlan) {
    limits.members = Math.min(limits.members, sub.pendingPlan.maxMembers);
    limits.locations = Math.min(limits.locations, sub.pendingPlan.maxLocations);
    limits.storageMb = Math.min(limits.storageMb, sub.pendingPlan.maxStorageMb);
  }

  return {
    subscriptionId: sub.id,
    status,
    planId: sub.planId,
    planKey: sub.plan.key,
    planName: sub.plan.name,
    isCustom: sub.plan.isCustom,
    limits,
    features: new Set(sub.plan.features.filter((f) => f.enabled).map((f) => f.featureKey).filter(isFeatureKey)),
    billingInterval: sub.plan.billingInterval,
    trialStartedAt: sub.trialStartedAt,
    trialEndsAt: sub.trialEndsAt,
    trialDaysRemaining: status === 'TRIALING' ? daysRemaining(sub.trialEndsAt, now) : null,
    trialPhase: trialPhase(sub, status, now, settings.trialExpiringDays),
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelReason: sub.cancelReason,
    pastDueSince: sub.pastDueSince,
    pendingPlanKey: sub.pendingPlan?.key ?? null,
    pendingChangeAt: sub.pendingChangeAt,
    provider: sub.provider,
    providerSubscriptionRef: sub.providerSubscriptionRef,
    paymentMethodSummary: sub.paymentMethodSummary,
    canWrite: canWriteIn(status),
  };
}

/** Start the 14-day free trial for a new business (inside the business-creation transaction). */
export async function startTrial(db: Db, businessId: string, now = new Date()): Promise<{ trialEndsAt: Date }> {
  const plan = await db.plan.findUniqueOrThrow({ where: { key: TRIAL_PLAN_KEY } });
  const trialEndsAt = new Date(now.getTime() + env().TRIAL_DAYS * DAY);
  await db.subscription.create({
    data: { businessId, planId: plan.id, status: 'TRIALING', trialStartedAt: now, trialEndsAt },
  });
  return { trialEndsAt };
}

/** Throw SUBSCRIPTION_INACTIVE when the business is in read-only mode. */
export function assertCanWrite(sub: EffectiveSubscription): void {
  if (!sub.canWrite) throw Errors.subscriptionInactive();
}

export type LimitKind = 'members' | 'locations' | 'storage';

/** Seats in use: ACTIVE members plus pending invitations (an invite reserves a seat). Suspended/archived are free. */
export async function countSeats(tx: Db, businessId: string, excludeMembershipId?: string): Promise<number> {
  return tx.membership.count({
    where: {
      businessId,
      status: { in: ['ACTIVE', 'INVITED'] },
      ...(excludeMembershipId ? { id: { not: excludeMembershipId } } : {}),
    },
  });
}

/**
 * Enforce plan limits. `adding` is how much is about to be added (1 seat, 1 location,
 * or N bytes of storage). Call inside the transaction that does the insert; tenant
 * tables (files, locations) require withTenant().
 */
export async function assertWithinLimit(
  tx: Tx,
  businessId: string,
  sub: EffectiveSubscription,
  kind: LimitKind,
  adding = 1,
  opts: { excludeMembershipId?: string } = {},
): Promise<void> {
  switch (kind) {
    case 'members': {
      const used = await countSeats(tx, businessId, opts.excludeMembershipId);
      if (used + adding > sub.limits.members) throw Errors.planLimit('team members', sub.limits.members);
      return;
    }
    case 'locations': {
      const used = await tx.location.count({ where: { businessId, status: 'ACTIVE' } });
      if (used + adding > sub.limits.locations) throw Errors.planLimit('locations', sub.limits.locations);
      return;
    }
    case 'storage': {
      const agg = await tx.file.aggregate({
        where: { businessId, status: { in: ['ACTIVE', 'ARCHIVED', 'TRASHED'] } },
        _sum: { sizeBytes: true },
      });
      const usedBytes = agg._sum.sizeBytes ?? 0;
      const limitBytes = sub.limits.storageMb * 1024 * 1024;
      if (usedBytes + adding > limitBytes) throw Errors.planLimit('MB of storage', sub.limits.storageMb);
      return;
    }
  }
}
