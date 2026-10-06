import { prisma, withTenant, type Db, type Tx } from '@/server/db/client';
import { enqueue } from '@/server/jobs/queue';
import { JobTypes } from '@/server/jobs/types';
import type { EmailMessage } from './email';

/**
 * Queue an email. Never sends inline: the request returns immediately and the
 * worker delivers (with retries). Pass the caller's transaction so the email is
 * only queued if the surrounding change commits.
 */
export async function queueEmail(
  db: Db,
  message: EmailMessage,
  opts: { dedupeKey?: string; businessId?: string } = {},
): Promise<void> {
  await enqueue(db, JobTypes.emailSend, { ...message }, { dedupeKey: opts.dedupeKey, businessId: opts.businessId });
}

/**
 * Notification categories.
 *  - security / billing / account / team: transactional — always delivered; they are not marketing and cannot be switched off.
 *  - trial_reminders / team_activity: optional — a person can turn them off in their account settings.
 */
export const OPTIONAL_CATEGORIES = {
  trial_reminders: 'Free-trial reminders for businesses I manage billing for',
  team_activity: 'Team changes (someone joins, a role changes)',
  inventory_alerts: 'Low-stock and out-of-stock alerts',
  purchasing: 'Purchase order approvals and deliveries',
  job_assignments: 'Jobs assigned to me or taken off me',
} as const;
export type OptionalCategory = keyof typeof OPTIONAL_CATEGORIES;
export type Category = 'security' | 'billing' | 'account' | 'team' | OptionalCategory;

export const isOptionalCategory = (c: string): c is OptionalCategory => c in OPTIONAL_CATEGORIES;

export interface Recipient {
  id: string;
  email: string;
  name: string;
}

/** Email a person, honouring their preferences for optional categories only. */
export async function emailUser(
  db: Db,
  who: Recipient,
  category: Category,
  build: (to: string, name: string) => EmailMessage,
  opts: { dedupeKey?: string; businessId?: string } = {},
): Promise<boolean> {
  if (isOptionalCategory(category)) {
    const pref = await db.userNotificationPreference.findUnique({ where: { userId_category: { userId: who.id, category } } });
    if (pref && !pref.emailEnabled) return false;
  }
  const message = build(who.email, who.name);
  await queueEmail(db, message, opts);
  // A security alert is also shown in the app, in every business the person belongs to, so it is seen even if the email is not.
  if (category === 'security') await alertInApp(who.id, message);
  return true;
}

export async function getPreferences(db: Db, userId: string): Promise<Record<OptionalCategory, boolean>> {
  const rows = await db.userNotificationPreference.findMany({ where: { userId } });
  const out = {} as Record<OptionalCategory, boolean>;
  for (const k of Object.keys(OPTIONAL_CATEGORIES) as OptionalCategory[]) out[k] = rows.find((r) => r.category === k)?.emailEnabled ?? true;
  return out;
}

export interface InAppNotification {
  businessId: string;
  userId: string;
  /** One of NotificationTypes (see events.ts). */
  type: string;
  title: string;
  body?: string;
  linkUrl?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
  entityType?: string;
  entityId?: string;
  /**
   * Repetitive, low-importance events of the same kind fold into ONE unread notification ("5 low-stock alerts") instead of piling
   * up. HIGH-priority notifications (money, security) are never folded: each one is shown on its own.
   */
  groupKey?: string;
}

/** Create an in-app notification. Must run inside withTenant(businessId, ...). */
export async function notifyInApp(tx: Tx, n: InAppNotification): Promise<void> {
  const priority = n.priority ?? 'NORMAL';
  if (n.groupKey && priority !== 'HIGH') {
    const open = await tx.notification.findFirst({ where: { businessId: n.businessId, userId: n.userId, groupKey: n.groupKey, readAt: null }, orderBy: { createdAt: 'desc' } });
    if (open) {
      const count = open.groupCount + 1;
      await tx.notification.update({ where: { id: open.id }, data: { groupCount: count, title: n.title, body: n.body ?? open.body, linkUrl: n.linkUrl ?? open.linkUrl, createdAt: new Date() } });
      return;
    }
  }
  await tx.notification.createMany({
    data: [{
      businessId: n.businessId, userId: n.userId, type: n.type, title: n.title, body: n.body ?? null, linkUrl: n.linkUrl ?? null, priority,
      entityType: n.entityType ?? null, entityId: n.entityId ?? null, groupKey: n.groupKey ?? null,
    }],
  });
}

export async function unreadCount(tx: Tx, userId: string): Promise<number> {
  return tx.notification.count({ where: { userId, readAt: null } });
}

/**
 * People who should hear about a business's billing: everyone with an active
 * membership whose role grants settings.manage_billing (always includes the Owner).
 */
export async function billingContacts(db: Db, businessId: string): Promise<Recipient[]> {
  const rows = await db.membership.findMany({
    where: {
      businessId,
      status: 'ACTIVE',
      user: { status: 'ACTIVE' },
      role: { permissions: { some: { permission: 'settings.manage_billing' } } },
    },
    select: { user: { select: { id: true, email: true, name: true } } },
  });
  return rows.flatMap((r) => (r.user ? [r.user] : []));
}

/**
 * Show a security email's message in the notification centre of every business the person works in. These cannot be switched off and
 * are never folded together: each is shown on its own, at high priority. Best effort: it can never block the change that caused it.
 */
export async function alertInApp(userId: string, message: { subject: string; text: string }): Promise<void> {
  try {
    const memberships = await prisma().membership.findMany({ where: { userId, status: 'ACTIVE' }, select: { businessId: true } });
    const paragraphs = message.text.split(/\n{2,}/);
    const body = (paragraphs[1] ?? '').slice(0, 300) || undefined;
    for (const m of memberships) {
      await withTenant(m.businessId, (tx) => notifyInApp(tx, { businessId: m.businessId, userId, type: 'SECURITY_ALERT', title: message.subject, body, linkUrl: '/account/security', priority: 'HIGH' }));
    }
  } catch {
    // swallow: the email is the primary channel
  }
}

/**
 * Show a subscription event (trial ending, payment failed, grace, suspended) in the notification centre of the people who handle the
 * business's billing. The email is the primary channel; this only makes sure it is seen. It never blocks the billing change.
 */
export async function billingInApp(businessId: string, type: string, title: string, body: string): Promise<void> {
  try {
    const people = await billingContacts(prisma(), businessId);
    await withTenant(businessId, async (tx) => {
      for (const p of people) await notifyInApp(tx, { businessId, userId: p.id, type, title, body, linkUrl: '/settings/billing', priority: 'HIGH' });
    });
  } catch {
    // swallow: billing state must not depend on notifications
  }
}
