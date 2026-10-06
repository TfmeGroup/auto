import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, seq } from '@/server/db/client';
import type { BusinessContext } from '@/server/context';

/**
 * The in-app notification centre. Notifications belong to one person in one business: a person only ever reads and changes their
 * own (the row filter is the signed-in user, never an id from the browser), and a notification from another business is invisible.
 */
export const notificationQuerySchema = paginationSchema.extend({
  filter: z.enum(['all', 'unread']).default('all'),
  type: z.string().max(60).optional(),
});

/** A link in a notification is always a path inside this app, never an address a stored value could point elsewhere. */
export const safeAppPath = (u: string | null): string | null => (u && /^\/(?!\/)[^\s\\]*$/.test(u) ? u : null);

export async function listNotifications(ctx: BusinessContext, query: unknown) {
  const q = parseOrThrow(notificationQuerySchema, query);
  const where = { businessId: ctx.business.id, userId: ctx.user.id, ...(q.filter === 'unread' ? { readAt: null } : {}), ...(q.type ? { type: q.type } : {}) };
  return withTenant(ctx.business.id, async (tx) => {
    const [total, unread, rows] = await seq([
      tx.notification.count({ where }),
      tx.notification.count({ where: { businessId: ctx.business.id, userId: ctx.user.id, readAt: null } }),
      tx.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return {
      unread,
      items: rows.map((n) => ({
        id: n.id, type: n.type, title: n.title, body: n.body, linkUrl: safeAppPath(n.linkUrl), priority: n.priority, count: n.groupCount, read: !!n.readAt, readAt: n.readAt, createdAt: n.createdAt,
        entityType: n.entityType, entityId: n.entityId,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function getUnreadCount(ctx: BusinessContext): Promise<number> {
  return withTenant(ctx.business.id, (tx) => tx.notification.count({ where: { businessId: ctx.business.id, userId: ctx.user.id, readAt: null } }));
}

export async function setRead(ctx: BusinessContext, id: string, read: boolean) {
  const nid = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const res = await tx.notification.updateMany({ where: { id: nid, businessId: ctx.business.id, userId: ctx.user.id }, data: { readAt: read ? new Date() : null } });
    if (res.count === 0) throw Errors.notFound('Notification');
    return { id: nid, read };
  });
}

export async function markAllRead(ctx: BusinessContext) {
  return withTenant(ctx.business.id, async (tx) => {
    const res = await tx.notification.updateMany({ where: { businessId: ctx.business.id, userId: ctx.user.id, readAt: null }, data: { readAt: new Date() } });
    return { marked: res.count };
  });
}
