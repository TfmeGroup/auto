import { prisma } from '@/server/db/client';
import { logger } from '@/lib/logger';
import { applyDuePlanChanges } from '@/server/billing/lifecycle';
import { deriveStatus, RENEWAL_TOLERANCE_MS } from '@/server/billing/state-machine';
import { getPlatformSettings } from '@/server/settings/platform';
import { purgeStaleBuckets } from '@/server/security/rate-limit';
import { runFinanceTasks, type FinanceTickResult } from '@/server/finance/scheduled';
import { runInventoryTasks, type InventoryTickResult } from '@/server/inventory/alerts';
import { expireInvitations } from '@/server/team/directory';
import { cleanupOrphanObjects, purgeExpiredTrash } from '@/server/files/lifecycle';
import { runBookingReminders, runServiceReminders } from '@/server/notifications/reminders';
import { runDueReports, type ReportTickResult } from '@/server/reports/schedules';
import { enqueue } from './queue';
import { JobTypes } from './types';

const DAY = 86_400_000;

export interface SchedulerResult {
  trialReminders: number;
  trialsExpired: number;
  delinquencyPhases: number;
  cancellationsExpired: number;
  downgradesApplied: number;
  housekeeping: Record<string, number>;
  finance: FinanceTickResult | null;
  inventory: (InventoryTickResult & { invitationsExpired: number }) | null;
  communications: { bookingReminders: number; serviceReminders: number; trashPurged: number } | null;
  reports: ReportTickResult | null;
}

/** Financial scans (quote expiry, overdue, reminders) are not minute-critical: run them at most every 10 minutes per process. */
let lastFinanceRun = 0;
/** Stock alerts, late orders and invitation expiry are likewise gentle: at most every 5 minutes per process. */
let lastInventoryRun = 0;
/** Reminders look at every business, so they run at most every 10 minutes; the trash cleanup at most hourly. */
let lastCommRun = 0;
let lastTrashRun = 0;
let lastOrphanRun = 0;
/** Scheduled reports are looked for every two minutes (a report goes out within a couple of minutes of its time). */
let lastReportRun = 0;

/**
 * Time-based work. Called every minute by the worker loop, from any number of worker
 * instances at once: everything it does is either a guarded update or an enqueue with a dedupe
 * key, so overlapping/repeated runs never double-send or double-apply anything.
 */
export async function runScheduledTasks(now = new Date()): Promise<SchedulerResult> {
  const settings = await getPlatformSettings();
  const out: SchedulerResult = { trialReminders: 0, trialsExpired: 0, delinquencyPhases: 0, cancellationsExpired: 0, downgradesApplied: 0, housekeeping: {}, finance: null, inventory: null, communications: null, reports: null };

  // ── trials: one reminder per window, then expiry ──
  const trials = await prisma().subscription.findMany({
    where: { status: 'TRIALING', trialEndsAt: { not: null }, business: { status: 'ACTIVE' } },
    select: { id: true, businessId: true, trialEndsAt: true },
  });
  for (const t of trials) {
    const end = t.trialEndsAt!;
    if (end <= now) {
      if (await enqueue(prisma(), JobTypes.trialExpired, { subscriptionId: t.id }, { dedupeKey: `trial-expired:${t.id}`, businessId: t.businessId })) out.trialsExpired++;
      continue;
    }
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / DAY);
    // The smallest configured threshold we are inside: with [7,3,1] and 5 days left that is 7; with 2 left it is 3.
    const window = settings.trialReminderDays.filter((d) => daysLeft <= d).sort((a, b) => a - b)[0];
    if (window !== undefined && (await enqueue(prisma(), JobTypes.trialReminder, { subscriptionId: t.id, day: window }, { dedupeKey: `trial-reminder:${t.id}:${window}`, businessId: t.businessId }))) out.trialReminders++;
  }

  // ── delinquency: past due -> grace -> suspended ──
  const paid = await prisma().subscription.findMany({
    where: { status: { in: ['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'] }, business: { status: 'ACTIVE' } },
  });
  for (const s of paid) {
    const derived = deriveStatus(s, now, settings);
    if (derived === s.status || !['PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED'].includes(derived)) continue;
    const since = s.pastDueSince ?? (s.currentPeriodEnd ? new Date(s.currentPeriodEnd.getTime() + RENEWAL_TOLERANCE_MS) : now);
    const phase = derived === 'PAST_DUE' ? 'past_due' : derived === 'GRACE_PERIOD' ? 'grace' : 'suspended';
    if (await enqueue(prisma(), JobTypes.billingDelinquency, { subscriptionId: s.id, phase }, { dedupeKey: `delinquency:${s.id}:${phase}:${since.getTime()}`, businessId: s.businessId })) out.delinquencyPhases++;
  }
  // A suspended subscription's stored status is already final; nothing to do until payment.

  // ── cancelled subscriptions whose paid period ended ──
  const cancelled = await prisma().subscription.findMany({ where: { status: 'CANCELED', currentPeriodEnd: { lt: now } }, select: { id: true, businessId: true } });
  for (const c of cancelled) {
    if (await enqueue(prisma(), JobTypes.subscriptionExpired, { subscriptionId: c.id }, { dedupeKey: `sub-expired:${c.id}`, businessId: c.businessId })) out.cancellationsExpired++;
  }

  out.downgradesApplied = await applyDuePlanChanges(now);
  out.housekeeping = await housekeeping(now);
  if (now.getTime() - lastFinanceRun >= 10 * 60_000) {
    lastFinanceRun = now.getTime();
    out.finance = await runFinanceTasks(now);
  }
  if (now.getTime() - lastInventoryRun >= 5 * 60_000) {
    lastInventoryRun = now.getTime();
    out.inventory = { ...(await runInventoryTasks(now)), invitationsExpired: await expireInvitations(now) };
  }

  if (now.getTime() - lastReportRun >= 2 * 60_000) {
    lastReportRun = now.getTime();
    out.reports = await runDueReports(now);
  }

  if (now.getTime() - lastCommRun >= 10 * 60_000) {
    lastCommRun = now.getTime();
    const comm = { bookingReminders: 0, serviceReminders: 0, trashPurged: 0 };
    const active = await prisma().business.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    for (const b of active) {
      try {
        comm.bookingReminders += await runBookingReminders(b.id, now);
        comm.serviceReminders += (await runServiceReminders(b.id, now)).sent;
      } catch (err) {
        logger.error({ businessId: b.id, err: String(err) }, 'communication tasks failed for a business');
      }
    }
    if (now.getTime() - lastTrashRun >= 60 * 60_000) {
      lastTrashRun = now.getTime();
      comm.trashPurged = (await purgeExpiredTrash(now)).purged;
    }
    // Objects with no record at all are looked for once a day, and only ones older than three days.
    if (now.getTime() - lastOrphanRun >= 24 * 60 * 60_000) {
      lastOrphanRun = now.getTime();
      await cleanupOrphanObjects(now).catch((err) => logger.error({ err: String(err) }, 'orphan cleanup failed'));
    }
    out.communications = comm;
  }

  if (Object.values(out).some((v) => typeof v === 'number' && v > 0) || (out.finance && Object.values(out.finance).some((v) => v > 0)) || (out.inventory && Object.values(out.inventory).some((v) => (v ?? 0) > 0)) || (out.communications && Object.values(out.communications).some((v) => v > 0))) logger.info(out, 'scheduler tick');
  return out;
}

/** Remove expired, no-longer-useful rows. Never touches business data or audit logs. */
async function housekeeping(now: Date): Promise<Record<string, number>> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const [sessions, tokens, challenges] = await Promise.all([
    prisma().session.deleteMany({ where: { OR: [{ expiresAt: { lt: ago(7) } }, { revokedAt: { lt: ago(30) } }] } }),
    prisma().authToken.deleteMany({ where: { OR: [{ expiresAt: { lt: ago(7) } }, { usedAt: { lt: ago(30) } }] } }),
    prisma().mfaChallenge.deleteMany({ where: { expiresAt: { lt: ago(1) } } }),
  ]);
  const buckets = await purgeStaleBuckets(24);
  return { sessions: sessions.count, authTokens: tokens.count, mfaChallenges: challenges.count, rateLimitBuckets: buckets };
}
