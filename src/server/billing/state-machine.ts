import type { PlatformSettings } from '@/server/settings/platform';

/**
 * SUBSCRIPTION STATE MACHINE (deterministic; documented in docs/BILLING.md)
 *
 * Stored status + a handful of dates fully determine the status that applies NOW,
 * so correctness never depends on a cron job having run. Two pure functions:
 *
 *   deriveStatus(sub, now, settings)   -> the effective status at `now`
 *   applyEvent(sub, event, now)        -> the stored-field changes caused by an event
 *
 * Effective statuses and what they allow:
 *
 *   TRIALING      14-day trial running                       full access
 *   ACTIVE        paid and current                           full access
 *   PAST_DUE      payment failed / period lapsed unpaid;     full access (provider retries)
 *                 first `pastDueRetryDays`
 *   GRACE_PERIOD  next `graceDays`                           full access + warnings
 *   SUSPENDED     grace over, still unpaid                   READ-ONLY, data preserved
 *   CANCELED      cancelled, paid through `currentPeriodEnd` full access until then
 *   EXPIRED       trial ended unconverted, or cancelled      READ-ONLY, data preserved
 *                 period ended
 *
 * Nothing here ever deletes data.
 */

export type SubStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELED' | 'EXPIRED';

export interface SubState {
  status: SubStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  pastDueSince: Date | null;
  convertedAt: Date | null;
}

const DAY = 86_400_000;
/** A renewal webhook may arrive slightly after the period boundary; don't flag that as lapsed. */
export const RENEWAL_TOLERANCE_MS = DAY;

export type WindowSettings = Pick<PlatformSettings, 'pastDueRetryDays' | 'graceDays'>;

export function deriveStatus(sub: SubState, now: Date, s: WindowSettings): SubStatus {
  const t = now.getTime();
  switch (sub.status) {
    case 'TRIALING':
      return sub.trialEndsAt && sub.trialEndsAt.getTime() > t ? 'TRIALING' : 'EXPIRED';

    case 'CANCELED':
      return sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() >= t ? 'CANCELED' : 'EXPIRED';

    case 'EXPIRED':
      return 'EXPIRED';

    case 'SUSPENDED':
      return 'SUSPENDED'; // only a successful payment (or the platform team) lifts this

    case 'ACTIVE':
    case 'PAST_DUE':
    case 'GRACE_PERIOD': {
      let since = sub.pastDueSince?.getTime() ?? null;
      if (since === null && sub.currentPeriodEnd && t > sub.currentPeriodEnd.getTime() + RENEWAL_TOLERANCE_MS) {
        since = sub.currentPeriodEnd.getTime() + RENEWAL_TOLERANCE_MS; // lapsed without a renewal
      }
      if (since === null) return sub.status === 'ACTIVE' ? 'ACTIVE' : sub.status;
      const elapsed = t - since;
      if (elapsed < s.pastDueRetryDays * DAY) return 'PAST_DUE';
      if (elapsed < (s.pastDueRetryDays + s.graceDays) * DAY) return 'GRACE_PERIOD';
      return 'SUSPENDED';
    }
  }
}

/** Can the business create or change data in this status? (Reads are always allowed.) */
export function canWriteIn(status: SubStatus): boolean {
  return status !== 'EXPIRED' && status !== 'SUSPENDED';
}

export type BillingEvent =
  | { type: 'PAYMENT_SUCCEEDED'; periodEnd: Date }
  | { type: 'PAYMENT_FAILED' }
  | { type: 'CANCELLED_BY_PROVIDER' }
  | { type: 'CANCELLED_BY_CUSTOMER' }
  | { type: 'SUSPENDED_BY_PLATFORM' };

export interface StatePatch {
  status?: SubStatus;
  pastDueSince?: Date | null;
  convertedAt?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  /** True when this event changed anything that deserves an audit entry. */
  changed: boolean;
}

/**
 * Stored-field changes for an event. `ACTIVE` is only ever reached through
 * PAYMENT_SUCCEEDED — a browser redirect is not an event.
 */
export function applyEvent(sub: SubState, event: BillingEvent, now: Date): StatePatch {
  switch (event.type) {
    case 'PAYMENT_SUCCEEDED':
      return {
        status: 'ACTIVE',
        pastDueSince: null,
        currentPeriodEnd: event.periodEnd,
        cancelAtPeriodEnd: false,
        ...(sub.convertedAt ? {} : { convertedAt: now }),
        changed: true,
      };

    case 'PAYMENT_FAILED': {
      // A failed FIRST payment (trialing/expired/cancelled) changes nothing: there was no paid state to lose.
      if (sub.status !== 'ACTIVE' && sub.status !== 'PAST_DUE' && sub.status !== 'GRACE_PERIOD') return { changed: false };
      // Keep the original clock if we are already delinquent: repeated failures must not reset the grace window.
      return { status: 'PAST_DUE', pastDueSince: sub.pastDueSince ?? now, changed: sub.pastDueSince === null || sub.status === 'ACTIVE' };
    }

    case 'CANCELLED_BY_PROVIDER':
    case 'CANCELLED_BY_CUSTOMER':
      if (sub.status === 'TRIALING' || sub.status === 'EXPIRED') return { changed: false };
      return { status: 'CANCELED', cancelAtPeriodEnd: true, changed: sub.status !== 'CANCELED' };

    case 'SUSPENDED_BY_PLATFORM':
      return { status: 'SUSPENDED', changed: sub.status !== 'SUSPENDED' };
  }
}

export type TrialPhase = 'trialing' | 'expiring' | 'expired' | 'converted' | null;

export function trialPhase(
  sub: SubState & { trialStartedAt?: Date | null },
  effective: SubStatus,
  now: Date,
  expiringDays: number,
): TrialPhase {
  if (sub.convertedAt) return 'converted';
  if (!sub.trialEndsAt) return null;
  if (effective === 'TRIALING') {
    const left = (sub.trialEndsAt.getTime() - now.getTime()) / DAY;
    return left <= expiringDays ? 'expiring' : 'trialing';
  }
  return effective === 'EXPIRED' ? 'expired' : null;
}

export function daysRemaining(end: Date | null, now: Date): number | null {
  if (!end) return null;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY));
}
