import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { escapeLike, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { Prisma, withTenant } from '@/server/db/client';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { visibleLocationIds } from '@/server/workshop/people';
import { EVENTS, EVENT_KEYS, type EventKey } from './events';

/**
 * Communication history: every operational message and what became of it. Only people with notification.view_history see it, on a
 * plan that includes it; location access applies; a message is shown as it was recorded (private links are not kept in the text).
 */
export const historyQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  customerId: uuidSchema.optional(),
  entityType: z.string().max(40).optional(),
  entityId: uuidSchema.optional(),
  channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']).optional(),
  status: z.enum(['QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'VIEWED', 'FAILED', 'CANCELLED', 'SKIPPED']).optional(),
  event: z.string().max(40).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'Queued', PROCESSING: 'Sending', SENT: 'Sent', DELIVERED: 'Delivered', VIEWED: 'Opened', FAILED: 'Failed', CANCELLED: 'Cancelled', SKIPPED: 'Not sent',
};

function present(c: CommunicationRow, customerName?: string | null) {
  return {
    id: c.id, channel: c.channel, event: c.event, eventLabel: (EVENTS as Record<string, { label: string }>)[c.event]?.label ?? c.event, category: c.category, recipient: c.recipient, subject: c.subject,
    status: c.status, statusLabel: STATUS_LABEL[c.status] ?? c.status, statusDetail: c.statusDetail, customerId: c.customerId, customerName: customerName ?? null, entityType: c.entityType, entityId: c.entityId,
    manual: c.manual, attempts: c.attempts, queuedAt: c.queuedAt, sentAt: c.sentAt, deliveredAt: c.deliveredAt, viewedAt: c.viewedAt, failedAt: c.failedAt, createdAt: c.createdAt, provider: c.provider,
  };
}
type CommunicationRow = Prisma.CommunicationGetPayload<object>;

export async function listCommunications(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'notification.view_history');
  requireFeature(ctx.subscription, 'communication_history');
  const q = parseOrThrow(historyQuerySchema, query);
  if (q.event && !(EVENT_KEYS as string[]).includes(q.event)) throw Errors.validation({ event: 'Unknown message type.' });
  const biz = ctx.business.id;
  return withTenant(biz, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const conds: Prisma.Sql[] = [Prisma.sql`m.business_id = ${biz}::uuid`];
    if (scope) conds.push(Prisma.sql`(m.location_id IS NULL OR m.location_id = ANY(${scope}::uuid[]))`);
    if (q.customerId) conds.push(Prisma.sql`m.customer_id = ${q.customerId}::uuid`);
    if (q.entityType) conds.push(Prisma.sql`m.entity_type = ${q.entityType}`);
    if (q.entityId) conds.push(Prisma.sql`m.entity_id = ${q.entityId}::uuid`);
    if (q.channel) conds.push(Prisma.sql`m.channel = ${q.channel}::comm_channel`);
    if (q.status) conds.push(Prisma.sql`m.status = ${q.status}::comm_status`);
    if (q.event) conds.push(Prisma.sql`m.event = ${q.event}`);
    if (q.from) conds.push(Prisma.sql`m.created_at >= ${q.from}::date`);
    if (q.to) conds.push(Prisma.sql`m.created_at < (${q.to}::date + 1)`);
    if (q.q) {
      const like = `%${escapeLike(q.q.toLowerCase())}%`;
      conds.push(Prisma.sql`(
        lower(coalesce(m.recipient, '')) LIKE ${like} ESCAPE '\\' OR lower(coalesce(m.subject, '')) LIKE ${like} ESCAPE '\\'
        OR m.customer_id IN (SELECT c.id FROM customers c WHERE c.business_id = ${biz}::uuid AND (lower(c.name) LIKE ${like} ESCAPE '\\' OR lower(c.customer_number) LIKE ${like} ESCAPE '\\'))
        OR (m.entity_type = 'job' AND m.entity_id IN (SELECT j.id FROM job_cards j WHERE j.business_id = ${biz}::uuid AND (lower(j.job_number) LIKE ${like} ESCAPE '\\' OR j.vehicle_id IN (SELECT v.id FROM vehicles v WHERE v.business_id = ${biz}::uuid AND lower(coalesce(v.registration, '')) LIKE ${like} ESCAPE '\\'))))
        OR (m.entity_type = 'vehicle' AND m.entity_id IN (SELECT v.id FROM vehicles v WHERE v.business_id = ${biz}::uuid AND lower(coalesce(v.registration, '')) LIKE ${like} ESCAPE '\\'))
        OR (m.entity_type = 'quote' AND m.entity_id IN (SELECT t.id FROM quotes t WHERE t.business_id = ${biz}::uuid AND lower(t.number) LIKE ${like} ESCAPE '\\'))
        OR (m.entity_type = 'invoice' AND m.entity_id IN (SELECT t.id FROM invoices t WHERE t.business_id = ${biz}::uuid AND lower(coalesce(t.number, '')) LIKE ${like} ESCAPE '\\'))
        OR (m.entity_type = 'payment' AND m.entity_id IN (SELECT t.id FROM payments t WHERE t.business_id = ${biz}::uuid AND lower(t.number) LIKE ${like} ESCAPE '\\'))
      )`);
    }
    const where = Prisma.join(conds, ' AND ');
    const total = (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM communications m WHERE ${where}`)[0]?.n ?? 0;
    const ids = await tx.$queryRaw<{ id: string }[]>`SELECT m.id FROM communications m WHERE ${where} ORDER BY m.created_at DESC, m.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const rows = await tx.communication.findMany({ where: { businessId: biz, id: { in: ids.map((r) => r.id) } } });
    const order = new Map(ids.map((r, i) => [r.id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const customers = await tx.customer.findMany({ where: { businessId: biz, id: { in: [...new Set(rows.flatMap((r) => (r.customerId ? [r.customerId] : [])))] } }, select: { id: true, name: true } });
    const names = new Map(customers.map((c) => [c.id, c.name]));
    return { items: rows.map((r) => present(r, r.customerId ? names.get(r.customerId) : null)), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

export async function getCommunication(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'notification.view_history');
  requireFeature(ctx.subscription, 'communication_history');
  const cid = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await tx.communication.findFirst({ where: { id: cid, businessId: ctx.business.id } });
    if (!c) throw Errors.notFound('Message');
    const scope = c.locationId ? await visibleLocationIds(tx, ctx) : null;
    if (c.locationId && scope && !scope.includes(c.locationId)) throw Errors.notFound('Message');
    const customer = c.customerId ? await tx.customer.findFirst({ where: { id: c.customerId, businessId: ctx.business.id }, select: { name: true } }) : null;
    return { ...present(c, customer?.name), body: c.body, templateKey: c.templateKey, templateVersion: c.templateVersion };
  });
}

/** Counts by status for the last N days, for the history screen header. */
export async function communicationSummary(ctx: BusinessContext, days = 30) {
  requirePermission(ctx, 'notification.view_history');
  requireFeature(ctx.subscription, 'communication_history');
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await withTenant(ctx.business.id, (tx) => tx.communication.groupBy({ by: ['status'], where: { businessId: ctx.business.id, createdAt: { gte: since } }, _count: true }));
  return Object.fromEntries(rows.map((r) => [r.status, r._count]));
}

export type { EventKey };
