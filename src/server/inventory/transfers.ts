import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import { usersWithPermission } from '@/server/finance/notify';
import type { BusinessContext } from '@/server/context';
import { accessibleLocations, actorOf, canSeeCosts, loadInventorySettings, lockInventoryRow, nextInventoryNumber } from './common';
import { notifyPurchasing } from './purchasing';
import { applyMovement, userNames } from './stock';

/**
 * Stock transfers between locations (plans with more than one location).
 *
 *   Draft -> Requested -> Approved -> In transit -> Received          Cancelled (before it ships)
 *
 * Shipping takes the stock off the source location (a TRANSFER_OUT movement); the stock then belongs to neither location while it is in
 * transit; receiving puts it on the destination's shelf (a TRANSFER_IN movement). The destination never sees the stock before it is
 * received, and a part's "location" is never simply edited.
 */

export const TRANSFER_STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', REQUESTED: 'Requested', APPROVED: 'Approved', IN_TRANSIT: 'In transit', RECEIVED: 'Received', CANCELLED: 'Cancelled' };

export const transferSchema = z.object({
  fromLocationId: uuidSchema,
  toLocationId: uuidSchema,
  notes: optionalText(500),
  /** Ask for it straight away (Requested/Approved) rather than saving a draft. */
  submit: z.boolean().optional(),
  lines: z.array(z.object({ partId: uuidSchema, quantity: z.coerce.number().int().min(1, 'At least 1').max(1_000_000) })).min(1, 'Add at least one part').max(100),
});

function guard(ctx: BusinessContext) {
  requirePermission(ctx, 'inventory.transfer');
  requireFeature(ctx.subscription, 'multi_location');
  assertCanWrite(ctx.subscription);
}

async function loadTransfer(tx: Tx, ctx: BusinessContext, id: string, opts: { lock?: boolean } = {}) {
  if (opts.lock) await lockInventoryRow(tx, 'stock_transfers', ctx.business.id, id);
  const mine = (await accessibleLocations(tx, ctx)).map((l) => l.id);
  const t = await tx.stockTransfer.findFirst({ where: { id, businessId: ctx.business.id, OR: [{ fromLocationId: { in: mine } }, { toLocationId: { in: mine } }] }, include: { lines: true } });
  if (!t) throw Errors.notFound('Transfer');
  return { t, mine };
}

export async function createTransfer(ctx: BusinessContext, input: unknown) {
  guard(ctx);
  const d = parseOrThrow(transferSchema, input);
  if (d.fromLocationId === d.toLocationId) throw Errors.validation({ toLocationId: 'Choose two different locations.' });
  return withTenant(ctx.business.id, async (tx) => {
    const mine = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    if (!mine.includes(d.fromLocationId) && !mine.includes(d.toLocationId)) throw Errors.forbidden('You can only move stock to or from a location you have access to.');
    const both = await tx.location.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE', id: { in: [d.fromLocationId, d.toLocationId] } }, select: { id: true } });
    if (both.length !== 2) throw Errors.validation({ toLocationId: 'Choose locations of this business.' });
    const ids = d.lines.map((l) => l.partId);
    if (new Set(ids).size !== ids.length) throw Errors.validation({ lines: 'A part can only appear once on a transfer.' });
    const parts = await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: ids } }, select: { id: true, status: true, sku: true } });
    if (parts.length !== ids.length) throw Errors.validation({ lines: 'A line refers to a part that is not in your catalogue.' });
    const inactive = parts.find((p) => p.status === 'ARCHIVED');
    if (inactive) throw Errors.validation({ lines: `${inactive.sku} is archived.` });
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const number = await nextInventoryNumber(tx, ctx.business.id, 'stock_transfer', settings);
    const t = await tx.stockTransfer.create({ data: { businessId: ctx.business.id, number, fromLocationId: d.fromLocationId, toLocationId: d.toLocationId, status: 'DRAFT', notes: d.notes ?? null, createdById: ctx.user.id } });
    await tx.stockTransferLine.createMany({ data: d.lines.map((l) => ({ businessId: ctx.business.id, transferId: t.id, partId: l.partId, quantity: l.quantity })) });
    await recordAudit(tx, ctx.meta, { action: AuditActions.transferCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'stock_transfer', resourceId: t.id, after: { number, from: d.fromLocationId, to: d.toLocationId, lines: d.lines.length } });
    if (d.submit) await requestIn(tx, ctx, t.id, settings);
    return { id: t.id, number };
  });
}

async function requestIn(tx: Tx, ctx: BusinessContext, id: string, settings: Awaited<ReturnType<typeof loadInventorySettings>>) {
  const { t } = await loadTransfer(tx, ctx, id, { lock: true });
  if (t.status !== 'DRAFT') throw Errors.conflict('Only a draft transfer can be requested.');
  const auto = !settings.transferApprovalRequired;
  const now = new Date();
  await tx.stockTransfer.update({ where: { id }, data: { status: auto ? 'APPROVED' : 'REQUESTED', requestedById: ctx.user.id, requestedAt: now, ...(auto ? { approvedAt: now } : {}) } });
  await recordAudit(tx, ctx.meta, { action: AuditActions.transferRequested, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'stock_transfer', resourceId: id, metadata: { number: t.number, autoApproved: auto } });
  if (!auto) {
    const approvers = await usersWithPermission(tx, ctx.business.id, 'inventory.approve_purchase');
    await notifyPurchasing(tx, ctx, approvers.map((a) => a.id), { type: 'TRANSFER_REQUESTED', title: `Transfer ${t.number} needs approval`, body: `${ctx.user.name} asked to move stock (${t.number}).`, url: `/inventory/transfers/${id}` });
  }
  return { id, status: auto ? ('APPROVED' as const) : ('REQUESTED' as const) };
}

export async function requestTransfer(ctx: BusinessContext, id: string) {
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => requestIn(tx, ctx, id, await loadInventorySettings(tx, ctx.business.id)));
}

export async function approveTransfer(ctx: BusinessContext, id: string) {
  guard(ctx);
  requirePermission(ctx, 'inventory.approve_purchase');
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const { t } = await loadTransfer(tx, ctx, id, { lock: true });
    if (t.status !== 'REQUESTED') throw Errors.conflict('Only a requested transfer can be approved.');
    await tx.stockTransfer.update({ where: { id }, data: { status: 'APPROVED', approvedById: ctx.user.id, approvedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.transferApproved, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'stock_transfer', resourceId: id, metadata: { number: t.number } });
    await notifyPurchasing(tx, ctx, [t.requestedById, t.createdById], { type: 'TRANSFER_APPROVED', title: `Transfer ${t.number} approved`, body: `${ctx.user.name} approved ${t.number}. It can now be shipped.`, url: `/inventory/transfers/${id}` });
    return { id, status: 'APPROVED' as const };
  });
}

/** Take the stock off the source. Needs access to the SOURCE location; everything leaves together or nothing does. */
export async function shipTransfer(ctx: BusinessContext, id: string) {
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const { t, mine } = await loadTransfer(tx, ctx, id, { lock: true });
    if (!mine.includes(t.fromLocationId)) throw Errors.forbidden('Only someone with access to the sending location can ship this transfer.');
    if (t.status !== 'APPROVED') throw Errors.conflict(t.status === 'IN_TRANSIT' ? 'This transfer has already been shipped.' : 'Only an approved transfer can be shipped.');
    const settings = await loadInventorySettings(tx, ctx.business.id);
    for (const l of [...t.lines].sort((a, b) => a.partId.localeCompare(b.partId))) {
      const part = await tx.part.findFirstOrThrow({ where: { id: l.partId, businessId: ctx.business.id }, select: { costCents: true } });
      const r = await applyMovement(tx, actorOf(ctx), { partId: l.partId, locationId: t.fromLocationId, type: 'TRANSFER_OUT', onHandDelta: -l.quantity, unitCostCents: part.costCents, referenceType: 'stock_transfer', referenceId: t.id, transferId: t.id, idempotencyKey: `transfer:${t.id}:${l.id}:out`, reason: `Transfer ${t.number} to another location` }, { settings, canGoNegative: false });
      await tx.stockTransferLine.update({ where: { id: l.id }, data: { unitCostCents: r.movement.unitCostCents } });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: 'IN_TRANSIT', shippedById: ctx.user.id, shippedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.transferShipped, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'stock_transfer', resourceId: id, metadata: { number: t.number, from: t.fromLocationId, to: t.toLocationId } });
    await notifyPurchasing(tx, ctx, [t.requestedById, t.createdById], { type: 'TRANSFER_SHIPPED', title: `Transfer ${t.number} is on its way`, body: `${ctx.user.name} shipped ${t.number}. It is not on the destination's shelf until it is received there.`, url: `/inventory/transfers/${id}` });
    return { id, status: 'IN_TRANSIT' as const };
  });
}

/** Put the stock on the destination's shelf. Needs access to the DESTINATION location. */
export async function receiveTransfer(ctx: BusinessContext, id: string) {
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const { t, mine } = await loadTransfer(tx, ctx, id, { lock: true });
    if (!mine.includes(t.toLocationId)) throw Errors.forbidden('Only someone with access to the receiving location can receive this transfer.');
    if (t.status !== 'IN_TRANSIT') throw Errors.conflict(t.status === 'RECEIVED' ? 'This transfer has already been received.' : 'Only a transfer that has been shipped can be received.');
    const settings = await loadInventorySettings(tx, ctx.business.id);
    for (const l of [...t.lines].sort((a, b) => a.partId.localeCompare(b.partId))) {
      await applyMovement(tx, actorOf(ctx), { partId: l.partId, locationId: t.toLocationId, type: 'TRANSFER_IN', onHandDelta: l.quantity, unitCostCents: l.unitCostCents, referenceType: 'stock_transfer', referenceId: t.id, transferId: t.id, idempotencyKey: `transfer:${t.id}:${l.id}:in`, reason: `Transfer ${t.number} received` }, { settings });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: 'RECEIVED', receivedById: ctx.user.id, receivedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.transferReceived, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'stock_transfer', resourceId: id, metadata: { number: t.number, from: t.fromLocationId, to: t.toLocationId } });
    await notifyPurchasing(tx, ctx, [t.requestedById, t.createdById, t.shippedById], { type: 'TRANSFER_RECEIVED', title: `Transfer ${t.number} received`, body: `${ctx.user.name} received ${t.number}.`, url: `/inventory/transfers/${id}` });
    return { id, status: 'RECEIVED' as const };
  });
}

export async function cancelTransfer(ctx: BusinessContext, id: string, input: unknown) {
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(z.object({ reason: optionalText(300) }), input ?? {});
  return withTenant(ctx.business.id, async (tx) => {
    const { t } = await loadTransfer(tx, ctx, id, { lock: true });
    if (!['DRAFT', 'REQUESTED', 'APPROVED'].includes(t.status)) throw Errors.conflict(t.status === 'IN_TRANSIT' ? 'This transfer has already left. Receive it at the destination.' : 'This transfer can no longer be cancelled.');
    await tx.stockTransfer.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: d.reason ?? null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.transferCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'stock_transfer', resourceId: id, before: { status: t.status }, metadata: { number: t.number, reason: d.reason ?? null } });
    return { id, status: 'CANCELLED' as const };
  });
}

export async function listTransfers(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(paginationSchema.extend({ status: z.string().max(100).optional() }), query);
  const statuses = q.status ? q.status.split(',').map((s) => s.trim().toUpperCase()) : null;
  return withTenant(ctx.business.id, async (tx) => {
    const locs = await accessibleLocations(tx, ctx);
    const mine = locs.map((l) => l.id);
    const where = { businessId: ctx.business.id, OR: [{ fromLocationId: { in: mine } }, { toLocationId: { in: mine } }], ...(statuses ? { status: { in: statuses as never[] } } : {}) };
    const all = new Map((await tx.location.findMany({ where: { businessId: ctx.business.id }, select: { id: true, name: true } })).map((l) => [l.id, l.name]));
    const total = await tx.stockTransfer.count({ where });
    const rows = await tx.stockTransfer.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lines: true } });
    return { items: rows.map((t) => ({ id: t.id, number: t.number, status: t.status, from: all.get(t.fromLocationId) ?? '', to: all.get(t.toLocationId) ?? '', units: t.lines.reduce((s, l) => s + l.quantity, 0), createdAt: t.createdAt, shippedAt: t.shippedAt, receivedAt: t.receivedAt })), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

export async function getTransfer(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, id);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const { t, mine } = await loadTransfer(tx, ctx, id);
    const all = new Map((await tx.location.findMany({ where: { businessId: ctx.business.id }, select: { id: true, name: true } })).map((l) => [l.id, l.name]));
    const parts = new Map((await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: t.lines.map((l) => l.partId) } }, select: { id: true, sku: true, name: true } })).map((p) => [p.id, p]));
    const names = await userNames(tx, [t.requestedById, t.approvedById, t.shippedById, t.receivedById, t.createdById]);
    const n = (u: string | null) => (u ? (names.get(u) ?? null) : null);
    return {
      transfer: { id: t.id, number: t.number, status: t.status, from: all.get(t.fromLocationId) ?? '', to: all.get(t.toLocationId) ?? '', fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, notes: t.notes, createdAt: t.createdAt, requestedAt: t.requestedAt, approvedAt: t.approvedAt, shippedAt: t.shippedAt, receivedAt: t.receivedAt, cancelledAt: t.cancelledAt, cancelReason: t.cancelReason, requestedBy: n(t.requestedById), approvedBy: n(t.approvedById), shippedBy: n(t.shippedById), receivedBy: n(t.receivedById) },
      lines: t.lines.map((l) => ({ id: l.id, partId: l.partId, sku: parts.get(l.partId)?.sku ?? '', name: parts.get(l.partId)?.name ?? '', quantity: l.quantity, unitCostCents: costs ? l.unitCostCents : null })),
      can: {
        request: t.status === 'DRAFT', approve: t.status === 'REQUESTED', ship: t.status === 'APPROVED' && mine.includes(t.fromLocationId), receive: t.status === 'IN_TRANSIT' && mine.includes(t.toLocationId),
        cancel: ['DRAFT', 'REQUESTED', 'APPROVED'].includes(t.status),
      },
    };
  });
}
