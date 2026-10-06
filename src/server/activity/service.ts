import { z } from 'zod';
import { withTenant, type Tx, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { can, requirePermission } from '@/server/permissions/authorize';
import type { Permission } from '@/server/permissions/catalog';
import type { BusinessContext } from '@/server/context';

/**
 * The activity feed behind the customer, vehicle and job timelines.
 *
 * Every event is written by the service that made the change, in the same transaction (so a
 * rolled-back change leaves no event) — nothing is ever synthesised at read time. The table is
 * append-only at the database level.
 *
 * Reading is permission-aware: each event type belongs to an area, and a timeline only returns the
 * areas the caller may view (a technician without booking.view does not see booking events on a
 * customer's timeline). `data` carries ids and short facts only; it never carries notes or prices.
 */

export interface ActivityInput {
  type: string;
  summary: string;
  customerId?: string | null;
  vehicleId?: string | null;
  jobId?: string | null;
  bookingId?: string | null;
  visibility?: 'INTERNAL' | 'CUSTOMER';
  data?: Record<string, unknown>;
}

export async function recordActivity(tx: Tx, businessId: string, actorId: string | null, e: ActivityInput): Promise<void> {
  await tx.activityEvent.create({
    data: {
      businessId,
      type: e.type,
      summary: e.summary.slice(0, 300),
      customerId: e.customerId ?? null,
      vehicleId: e.vehicleId ?? null,
      jobId: e.jobId ?? null,
      bookingId: e.bookingId ?? null,
      visibility: e.visibility ?? 'INTERNAL',
      data: (e.data ?? undefined) as never,
      actorId,
    },
  });
}

/** Which permission lets a caller see events of a given type. The first matching prefix wins. */
const AREAS: { prefix: string; permission: Permission }[] = [
  { prefix: 'customer.', permission: 'customer.view' },
  { prefix: 'vehicle.', permission: 'vehicle.view' },
  { prefix: 'booking.', permission: 'booking.view' },
  { prefix: 'job.', permission: 'job.view' },
  { prefix: 'inspection.', permission: 'job.view' },
  { prefix: 'diagnosis.', permission: 'job.view' },
  { prefix: 'work.', permission: 'job.view' },
  { prefix: 'quote.', permission: 'quote.view' },
  { prefix: 'invoice.', permission: 'invoice.view' },
  { prefix: 'payment.', permission: 'payment.view' },
  { prefix: 'credit_note.', permission: 'credit_note.view' },
];

export const timelineQuerySchema = paginationSchema.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export type TimelineScope = { customerId: string } | { vehicleId: string } | { jobId: string };

export async function listTimeline(ctx: BusinessContext, scope: TimelineScope, query: unknown) {
  const q = parseOrThrow(timelineQuerySchema, query);
  const own: Permission = 'customerId' in scope ? 'customer.view' : 'vehicleId' in scope ? 'vehicle.view' : 'job.view';
  requirePermission(ctx, own);

  const allowedPrefixes = AREAS.filter((a) => can(ctx, a.permission)).map((a) => a.prefix);
  const idField = 'customerId' in scope ? 'customerId' : 'vehicleId' in scope ? 'vehicleId' : 'jobId';
  const id = parseOrThrow(uuidSchema, Object.values(scope)[0]);
  if (allowedPrefixes.length === 0) throw Errors.forbidden();

  const where = {
    businessId: ctx.business.id,
    [idField]: id,
    OR: allowedPrefixes.map((p) => ({ type: { startsWith: p } })),
  };
  return withTenant(ctx.business.id, async (tx) => {
    const [total, rows] = await seq([
      tx.activityEvent.count({ where }),
      tx.activityEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v))];
    const users = actorIds.length
      ? await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE id = ANY(${actorIds}::uuid[])`
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      items: rows.map((r) => ({
        id: r.id, type: r.type, summary: r.summary, visibility: r.visibility, createdAt: r.createdAt,
        actor: r.actorId ? (names.get(r.actorId) ?? null) : null,
        customerId: r.customerId, vehicleId: r.vehicleId, jobId: r.jobId, bookingId: r.bookingId,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}
