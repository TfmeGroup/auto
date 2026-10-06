import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { prisma, withTenant } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requirePermission } from '@/server/permissions/authorize';
import { RESOURCES } from '@/server/files/registry';
import { visibleLocationIds } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import { sendCustomerMessage } from './comms';

/**
 * Messages written by a person, and actions on messages that already exist. A manual message goes to ONE customer about ONE record
 * through the same service, queue and history as everything else: there is no way to send to a list, so this cannot be used as a
 * bulk or marketing tool.
 */
const manualSchema = z.object({
  customerId: uuidSchema,
  subject: z.string().trim().max(150).optional(),
  body: z.string().trim().min(2, 'Write a message.').max(1000, 'Keep it under 1000 characters.'),
  entityType: z.enum(['job', 'quote', 'invoice', 'booking', 'vehicle']).optional(),
  entityId: uuidSchema.optional(),
});

export async function sendManualMessage(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'notification.send');
  requirePermission(ctx, 'customer.view');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(manualSchema, input);
  if (!!d.entityType !== !!d.entityId) throw Errors.validation({ entityId: 'Give both the record type and the record.' });
  return withTenant(ctx.business.id, async (tx) => {
    let locationId: string | null = null;
    if (d.entityType && d.entityId) {
      const owner = await RESOURCES[d.entityType]!.owner(tx, ctx.business.id, d.entityId);
      if (!owner) throw Errors.notFound('Record');
      if (owner.customerId && owner.customerId !== d.customerId) throw Errors.validation({ entityId: 'That record belongs to a different customer.' });
      locationId = owner.locationId ?? null;
      const scope = locationId ? await visibleLocationIds(tx, ctx) : null;
      if (locationId && scope && !scope.includes(locationId)) throw Errors.notFound('Record');
    }
    const out = await sendCustomerMessage(tx, ctx.business.id, {
      event: 'MANUAL_MESSAGE', customerId: d.customerId, entity: d.entityType && d.entityId ? { type: d.entityType, id: d.entityId } : undefined, locationId,
      dedupeKey: `manual:${randomUUID()}`, manual: { userId: ctx.user.id, subject: d.subject, body: d.body },
    });
    const queued = out.filter((o) => o.status === 'queued');
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.communicationSentManually, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'customer', resourceId: d.customerId,
      metadata: { channels: out.map((o) => `${o.channel}:${o.status}`), entity: d.entityType ?? null, entityId: d.entityId ?? null, length: d.body.length },
    });
    if (queued.length === 0) throw Errors.validation({ customerId: out[0]?.detail ?? 'The message could not be sent.' });
    return out;
  });
}

/** Send a failed message again (the original job and its content are reused; nothing is rewritten). */
export async function retryCommunication(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'notification.send');
  assertCanWrite(ctx.subscription);
  const cid = parseOrThrow(uuidSchema, id);
  await withTenant(ctx.business.id, async (tx) => {
    const c = await tx.communication.findFirst({ where: { id: cid, businessId: ctx.business.id } });
    if (!c) throw Errors.notFound('Message');
    if (c.status !== 'FAILED') throw Errors.conflict('Only a failed message can be sent again.');
    const job = await prisma().job.findFirst({ where: { dedupeKey: `comm:${c.id}`, businessId: ctx.business.id } });
    const payload = job?.payload as { scrubbed?: boolean } | null;
    if (!job || payload?.scrubbed) throw Errors.conflict('This message can no longer be re-sent. Send a new message instead.');
    await tx.communication.update({ where: { id: c.id }, data: { status: 'QUEUED', statusDetail: 'Sending again.', failedAt: null } });
    await prisma().job.update({ where: { id: job.id }, data: { status: 'PENDING', attempts: 0, runAt: new Date(), lockedAt: null, lockedBy: null, lastError: null, completedAt: null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.communicationRetried, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'communication', resourceId: c.id, metadata: { channel: c.channel, event: c.event } });
  });
  return { id: cid };
}

/** Stop a message that has not gone out yet. */
export async function cancelCommunication(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'notification.send');
  assertCanWrite(ctx.subscription);
  const cid = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await tx.communication.findFirst({ where: { id: cid, businessId: ctx.business.id } });
    if (!c) throw Errors.notFound('Message');
    if (c.status !== 'QUEUED') throw Errors.conflict('Only a message that has not been sent yet can be cancelled.');
    await tx.communication.update({ where: { id: c.id }, data: { status: 'CANCELLED', statusDetail: 'Cancelled before sending.' } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.communicationCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'communication', resourceId: c.id, metadata: { channel: c.channel, event: c.event } });
    return { id: c.id };
  });
}
