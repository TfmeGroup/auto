import { z } from 'zod';
import { withTenant, seq } from '@/server/db/client';
import { pageMeta, paginationSchema, parseOrThrow } from '@/lib/validation';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

export const auditListSchema = paginationSchema.extend({
  action: z.string().max(80).optional(),
  resourceType: z.string().max(40).optional(),
  resourceId: z.string().max(64).optional(),
});

/** Read the business's audit trail (newest first). Read-only: there is no write API. */
export async function listAuditLog(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'audit.view');
  const q = parseOrThrow(auditListSchema, query);
  const where = {
    businessId: ctx.business.id,
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.resourceType ? { resourceType: q.resourceType } : {}),
    ...(q.resourceId ? { resourceId: q.resourceId } : {}),
  };
  return withTenant(ctx.business.id, async (tx) => {
    const [total, rows] = await seq([
      tx.auditLog.count({ where }),
      tx.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = userIds.length ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        user: r.userId ? (names.get(r.userId) ?? 'Unknown user') : 'System',
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}
