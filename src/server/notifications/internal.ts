import type { Db, Tx } from '@/server/db/client';
import { INTERNAL_EVENTS, NotificationTypes, type NotificationType } from './events';
import { emailUser, notifyInApp, type Category } from './service';
import { internalRuleFor, loadCommSettings } from './settings';
import { templates } from './templates';

/**
 * Telling the workshop's own people about an event. One routing rule for every internal event: who hears (people holding a
 * permission, by default; the business can change it), through which channels, and how repetitive low-priority events fold together.
 * Only people with the right permission are ever told, so internal stock, cost or HR information cannot reach someone who should not
 * have it, and nothing here is ever sent to a customer.
 */
const EMAIL_CATEGORY: Partial<Record<NotificationType, Category>> = {
  LOW_STOCK: 'inventory_alerts', OUT_OF_STOCK: 'inventory_alerts', PO_APPROVED: 'purchasing', PO_RECEIVED: 'purchasing', PO_LATE: 'purchasing', JOB_STATUS_CHANGED: 'job_assignments',
};

export interface InternalNotice {
  title: string;
  body?: string;
  linkUrl?: string;
  entity?: { type: string; id: string };
  /** People who are always told in addition to the rule (e.g. the technician a job was just given to). */
  alsoUserIds?: string[];
  /** People who are not told (e.g. the person who just did the thing). */
  excludeUserIds?: string[];
  /** Folds into one notification with the same key while unread. Defaults to the event type for events marked as groupable. */
  groupKey?: string;
}

export async function notifyInternal(tx: Tx, businessId: string, type: NotificationType, n: InternalNotice): Promise<number> {
  const def = INTERNAL_EVENTS[type];
  if (!def) throw new Error(`${type} is not a routable internal event`);
  const settings = await loadCommSettings(tx, businessId);
  const rule = internalRuleFor(settings, type)!;
  if (!rule.enabled && !n.alsoUserIds?.length) return 0;

  const holders = rule.enabled
    ? await tx.membership.findMany({ where: { businessId, status: 'ACTIVE', user: { status: 'ACTIVE' }, role: { permissions: { some: { permission: rule.permission } } } }, select: { user: { select: { id: true, email: true, name: true } } } })
    : [];
  const also = n.alsoUserIds?.length
    ? await tx.membership.findMany({ where: { businessId, status: 'ACTIVE', userId: { in: n.alsoUserIds }, user: { status: 'ACTIVE' } }, select: { user: { select: { id: true, email: true, name: true } } } })
    : [];
  const people = new Map<string, { id: string; email: string; name: string }>();
  for (const m of [...holders, ...also]) if (m.user) people.set(m.user.id, m.user);
  for (const id of n.excludeUserIds ?? []) people.delete(id);

  const business = rule.email ? await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } }) : null;
  for (const u of people.values()) {
    if (rule.inApp || also.some((a) => a.user?.id === u.id)) {
      await notifyInApp(tx, {
        businessId, userId: u.id, type, title: n.title, body: n.body, linkUrl: n.linkUrl, priority: def.priority, entityType: n.entity?.type, entityId: n.entity?.id,
        groupKey: n.groupKey ?? (def.group ? type : undefined),
      });
    }
    if (rule.email && business) {
      await emailUser(tx as unknown as Db, u, EMAIL_CATEGORY[type] ?? 'team', (to, name) => templates.inventoryNotice(to, name, business.name, n.title, n.body ?? n.title), { businessId });
    }
  }
  return people.size;
}

export { NotificationTypes };
