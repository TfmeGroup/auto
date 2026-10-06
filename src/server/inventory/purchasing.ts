import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { escapeLike, optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { todayIso } from '@/lib/tz';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { calculateDocument } from '@/server/finance/calc';
import { dateOnly, isoOf } from '@/server/finance/common';
import { usersWithPermission } from '@/server/finance/notify';
import { notifyInApp, emailUser } from '@/server/notifications/service';
import { sendCustomerMessage } from '@/server/notifications/comms';
import { generateDocument, generateOrQueue } from '@/server/documents/generator';
import { templates } from '@/server/notifications/templates';
import type { BusinessContext } from '@/server/context';
import { outstandingOf } from './calc';
import { accessibleLocations, canSeeCosts, loadInventorySettings, lockInventoryRow, nextInventoryNumber, resolveLocation, type InventorySettingsRow } from './common';
import { userNames } from './stock';

/**
 * Purchase orders: what the workshop buys from a supplier. This is a separate domain from customer invoices: a purchase order
 * never becomes an invoice and an invoice never becomes a purchase order; they only share the part records.
 *
 *   Draft -> (Pending approval -> Approved ->) Ordered -> Partially received -> Received      Cancelled
 *
 * Statuses only move along those lines (the database enforces it), lines are editable only while the order is a draft, and
 * a draft that needs approval cannot be ordered until someone with the approval permission has approved it.
 */

export const PO_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Awaiting approval', APPROVED: 'Approved', ORDERED: 'Ordered', PARTIALLY_RECEIVED: 'Partially received', RECEIVED: 'Received', CANCELLED: 'Cancelled',
};

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
const nullableIso = z.union([z.literal(''), z.null(), iso]).optional().transform((v) => (v === undefined ? undefined : v ? v : null));
const clearable = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

export const poLineSchema = z.object({
  partId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : null)),
  description: z.string().trim().max(300).default(''),
  supplierPartNumber: clearable(80),
  quantity: z.coerce.number().int('Enter a whole number').min(1, 'At least 1').max(1_000_000),
  unitCostCents: z.coerce.number().int('Enter whole cents').min(0, 'Cannot be negative').max(1_000_000_000),
  taxTreatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']).default('STANDARD'),
});

export const poSchema = z.object({
  supplierId: uuidSchema,
  locationId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  poDate: iso.optional(),
  expectedDate: nullableIso,
  notes: clearable(1000),
  internalNotes: clearable(1000),
  terms: clearable(2000),
  lines: z.array(poLineSchema).min(1, 'Add at least one line').max(200),
});

export const poListSchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.string().max(200).optional(),
  supplierId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  from: iso.optional(),
  to: iso.optional(),
  open: z.enum(['1']).optional(),
  late: z.enum(['1']).optional(),
});

export const needsApproval = (s: Pick<InventorySettingsRow, 'poApprovalRequired' | 'poApprovalThresholdCents'>, totalCents: number) =>
  s.poApprovalRequired && totalCents >= s.poApprovalThresholdCents;

async function loadPo(tx: Tx, ctx: BusinessContext, id: string, opts: { lock?: boolean } = {}) {
  if (opts.lock) await lockInventoryRow(tx, 'purchase_orders', ctx.business.id, id);
  const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
  const po = await tx.purchaseOrder.findFirst({ where: { id, businessId: ctx.business.id, locationId: { in: locs } }, include: { lines: { orderBy: { position: 'asc' } } } });
  if (!po) throw Errors.notFound('Purchase order');
  return po;
}

async function priceLines(tx: Tx, ctx: BusinessContext, supplierId: string, lines: z.output<typeof poLineSchema>[]) {
  const partIds = [...new Set(lines.map((l) => l.partId).filter((v): v is string => !!v))];
  const parts = await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: partIds } }, select: { id: true, name: true, sku: true, status: true } });
  if (parts.length !== partIds.length) throw Errors.validation({ lines: 'A line refers to a part that is not in your catalogue.' });
  for (const p of parts) if (p.status !== 'ACTIVE') throw Errors.validation({ lines: `${p.sku} is ${p.status.toLowerCase()} and cannot be ordered.` });
  const byId = new Map(parts.map((p) => [p.id, p]));
  const links = await tx.partSupplier.findMany({ where: { businessId: ctx.business.id, supplierId, partId: { in: partIds } }, select: { partId: true, supplierPartNumber: true } });
  const spn = new Map(links.map((l) => [l.partId, l.supplierPartNumber]));
  const tax = { vatRegistered: ctx.business.vatRegistered, vatRateBps: ctx.business.vatRateBps, pricesIncludeVat: false };
  const calc = calculateDocument(lines.map((l) => ({ quantityMilli: l.quantity * 1000, unitPriceCents: l.unitCostCents, discountType: 'NONE' as const, discountValue: 0, taxTreatment: l.taxTreatment })), tax);
  const rows = lines.map((l, i) => {
    const part = l.partId ? byId.get(l.partId) : undefined;
    const description = l.description || (part ? `${part.sku} — ${part.name}` : '');
    if (!description) throw Errors.validation({ lines: `Line ${i + 1} needs a description or a part.` });
    return {
      position: i + 1, partId: l.partId, description, supplierPartNumber: l.supplierPartNumber ?? (l.partId ? (spn.get(l.partId) ?? null) : null), quantityOrdered: l.quantity, unitCostCents: l.unitCostCents,
      taxTreatment: l.taxTreatment, vatRateBps: calc.lines[i]!.vatRateBps, subtotalCents: calc.lines[i]!.taxableCents, vatCents: calc.lines[i]!.vatCents, totalCents: calc.lines[i]!.totalCents,
    };
  });
  return { rows, calc };
}

// ───────── Create / edit ─────────

export async function createPurchaseOrder(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.purchase');
  requirePermission(ctx, 'inventory.view_costs');
  requireFeature(ctx.subscription, 'purchase_orders');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(poSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: d.supplierId, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true, name: true } });
    if (!supplier) throw Errors.validation({ supplierId: 'Choose an active supplier of this business.' });
    const locationId = await resolveLocation(tx, ctx, d.locationId);
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const { rows, calc } = await priceLines(tx, ctx, d.supplierId, d.lines);
    const today = todayIso(ctx.business.timezone);
    const poDate = d.poDate ?? today;
    if (d.expectedDate && d.expectedDate < poDate) throw Errors.validation({ expectedDate: 'The expected date cannot be before the order date.' });
    const number = await nextInventoryNumber(tx, ctx.business.id, 'purchase_order', settings, locationId);
    const po = await tx.purchaseOrder.create({
      data: {
        businessId: ctx.business.id, number, supplierId: d.supplierId, locationId, status: 'DRAFT', poDate: dateOnly(poDate), expectedDate: d.expectedDate ? dateOnly(d.expectedDate) : null,
        notes: d.notes ?? null, internalNotes: d.internalNotes ?? null, terms: d.terms ?? null, vatRegistered: ctx.business.vatRegistered, vatRateBps: ctx.business.vatRateBps,
        subtotalCents: calc.taxableCents, vatCents: calc.vatCents, totalCents: calc.totalCents, requiresApproval: needsApproval(settings, calc.totalCents), createdById: ctx.user.id, updatedById: ctx.user.id,
      },
    });
    await tx.purchaseOrderLine.createMany({ data: rows.map((r) => ({ ...r, businessId: ctx.business.id, purchaseOrderId: po.id })) });
    await recordAudit(tx, ctx.meta, { action: AuditActions.purchaseOrderCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'purchase_order', resourceId: po.id, after: { number, supplier: supplier.name, totalCents: po.totalCents, lines: rows.length } });
    return { id: po.id, number };
  });
}

export async function updatePurchaseOrder(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'inventory.purchase');
  requirePermission(ctx, 'inventory.view_costs');
  requireFeature(ctx.subscription, 'purchase_orders');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(poSchema.partial({ supplierId: true, lines: true }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const po = await loadPo(tx, ctx, id, { lock: true });
    if (po.status !== 'DRAFT') throw Errors.conflict('Only a draft order can be edited. Send it back to draft first, or create a new order.');
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const supplierId = d.supplierId ?? po.supplierId;
    if (d.supplierId && d.supplierId !== po.supplierId && !(await tx.supplier.findFirst({ where: { id: d.supplierId, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } }))) throw Errors.validation({ supplierId: 'Choose an active supplier of this business.' });
    const locationId = d.locationId ? await resolveLocation(tx, ctx, d.locationId) : po.locationId;
    const poDate = d.poDate ?? isoOf(po.poDate)!;
    const expected = d.expectedDate !== undefined ? d.expectedDate : isoOf(po.expectedDate);
    if (expected && expected < poDate) throw Errors.validation({ expectedDate: 'The expected date cannot be before the order date.' });
    let totals = { subtotalCents: po.subtotalCents, vatCents: po.vatCents, totalCents: po.totalCents };
    if (d.lines) {
      const { rows, calc } = await priceLines(tx, ctx, supplierId, d.lines);
      await tx.purchaseOrderLine.deleteMany({ where: { businessId: ctx.business.id, purchaseOrderId: id } });
      await tx.purchaseOrderLine.createMany({ data: rows.map((r) => ({ ...r, businessId: ctx.business.id, purchaseOrderId: id })) });
      totals = { subtotalCents: calc.taxableCents, vatCents: calc.vatCents, totalCents: calc.totalCents };
    }
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId, locationId, poDate: dateOnly(poDate), expectedDate: expected ? dateOnly(expected) : null, ...totals, requiresApproval: needsApproval(settings, totals.totalCents), updatedById: ctx.user.id,
        ...(d.notes !== undefined ? { notes: d.notes } : {}), ...(d.internalNotes !== undefined ? { internalNotes: d.internalNotes } : {}), ...(d.terms !== undefined ? { terms: d.terms } : {}),
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.purchaseOrderUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'purchase_order', resourceId: id, before: { totalCents: po.totalCents }, after: { totalCents: totals.totalCents }, metadata: { number: po.number } });
    return { id, number: po.number };
  });
}

// ───────── Workflow ─────────

async function notifyPurchasing(tx: Tx, ctx: BusinessContext, userIds: (string | null | undefined)[], n: { type: string; title: string; body: string; url: string }) {
  const unique = [...new Set(userIds.filter((u): u is string => !!u && u !== ctx.user.id))];
  if (unique.length === 0) return;
  const users = await tx.user.findMany({ where: { id: { in: unique }, status: 'ACTIVE' }, select: { id: true, email: true, name: true, firstName: true } });
  for (const u of users) {
    await notifyInApp(tx, { businessId: ctx.business.id, userId: u.id, type: n.type, title: n.title, body: n.body, linkUrl: n.url });
    await emailUser(tx, { id: u.id, email: u.email, name: u.firstName || u.name }, 'purchasing', (to, name) => templates.inventoryNotice(to, name, ctx.business.name, n.title, n.body, { label: 'Open', url: `${process.env.APP_URL ?? ''}${n.url}` }), { businessId: ctx.business.id });
  }
}

async function move(ctx: BusinessContext, id: string, to: 'PENDING_APPROVAL' | 'APPROVED' | 'DRAFT' | 'ORDERED' | 'CANCELLED', opts: { from: string[]; permission: 'inventory.purchase' | 'inventory.approve_purchase'; action: string; reason?: string; rejected?: boolean }) {
  requirePermission(ctx, opts.permission);
  requireFeature(ctx.subscription, 'purchase_orders');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const po = await loadPo(tx, ctx, id, { lock: true });
    if (!opts.from.includes(po.status)) throw Errors.conflict(`A ${PO_STATUS_LABEL[po.status]!.toLowerCase()} order cannot do that.`);
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const requires = needsApproval(settings, po.totalCents);
    const now = new Date();
    const data: Record<string, unknown> = { status: to, updatedById: ctx.user.id, requiresApproval: requires };
    if (to === 'PENDING_APPROVAL') {
      if (!requires) throw Errors.conflict('This order does not need approval. Place the order instead.');
      data.submittedAt = now;
    }
    if (to === 'APPROVED') {
      data.approvedById = ctx.user.id; data.approvedAt = now; data.rejectedReason = null;
    }
    if (to === 'DRAFT') {
      data.approvedById = null; data.approvedAt = null; data.submittedAt = null; data.rejectedReason = opts.rejected ? (opts.reason ?? null) : null;
    }
    if (to === 'ORDERED') {
      if (po.lines.length === 0) throw Errors.conflict('Add at least one line first.');
      if (requires && po.status !== 'APPROVED') throw Errors.forbidden('This order needs approval before it can be placed. Submit it for approval.');
      data.orderedAt = now; data.orderedById = ctx.user.id;
    }
    if (to === 'CANCELLED') {
      if (po.status === 'ORDERED' && !opts.reason) throw Errors.validation({ reason: 'Say why the order is being cancelled.' });
      data.cancelledAt = now; data.cancelReason = opts.reason ?? null;
    }
    const after = await tx.purchaseOrder.update({ where: { id }, data });
    await recordAudit(tx, ctx.meta, { action: opts.action, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'purchase_order', resourceId: id, before: { status: po.status }, after: { status: after.status }, metadata: { number: po.number, reason: opts.reason ?? null, totalCents: po.totalCents } });
    const url = `/purchase-orders/${id}`;
    if (to === 'PENDING_APPROVAL') {
      const approvers = await usersWithPermission(tx, ctx.business.id, 'inventory.approve_purchase');
      await notifyPurchasing(tx, ctx, approvers.map((a) => a.id), { type: 'PO_NEEDS_APPROVAL', title: `Purchase order ${po.number} needs approval`, body: `${ctx.user.name} submitted ${po.number} for approval (${formatMoney(po.totalCents, ctx.business.currency, ctx.business.locale)}).`, url });
    }
    if (to === 'APPROVED' || (to === 'DRAFT' && opts.rejected)) {
      await notifyPurchasing(tx, ctx, [po.createdById], { type: to === 'APPROVED' ? 'PO_APPROVED' : 'PO_REJECTED', title: to === 'APPROVED' ? `Purchase order ${po.number} approved` : `Purchase order ${po.number} was not approved`, body: to === 'APPROVED' ? `${ctx.user.name} approved ${po.number}. It can now be placed.` : `${ctx.user.name} sent ${po.number} back to draft${opts.reason ? `: ${opts.reason}` : '.'}`, url });
    }
    return { id, status: after.status };
  });
}

export const submitPurchaseOrder = (ctx: BusinessContext, id: string) => move(ctx, id, 'PENDING_APPROVAL', { from: ['DRAFT'], permission: 'inventory.purchase', action: AuditActions.purchaseOrderSubmitted });
export const approvePurchaseOrder = (ctx: BusinessContext, id: string) => move(ctx, id, 'APPROVED', { from: ['PENDING_APPROVAL'], permission: 'inventory.approve_purchase', action: AuditActions.purchaseOrderApproved });
export const rejectPurchaseOrder = (ctx: BusinessContext, id: string, input: unknown) => {
  const d = parseOrThrow(z.object({ reason: z.string().trim().min(3, 'Say why').max(300) }), input);
  return move(ctx, id, 'DRAFT', { from: ['PENDING_APPROVAL'], permission: 'inventory.approve_purchase', action: AuditActions.purchaseOrderRejected, reason: d.reason, rejected: true });
};
export const reopenPurchaseOrder = (ctx: BusinessContext, id: string) => move(ctx, id, 'DRAFT', { from: ['APPROVED'], permission: 'inventory.purchase', action: AuditActions.purchaseOrderUpdated });
export async function placePurchaseOrder(ctx: BusinessContext, id: string) {
  const out = await move(ctx, id, 'ORDERED', { from: ['DRAFT', 'APPROVED'], permission: 'inventory.purchase', action: AuditActions.purchaseOrderOrdered });
  // The order as placed is filed as a document (before anything about it can change), ready to send to the supplier.
  await generateOrQueue(ctx.business.id, ctx.user.id, 'purchase_order', id, { dedupeKey: `po:${id}:ordered` });
  return out;
}
export const cancelPurchaseOrder = (ctx: BusinessContext, id: string, input: unknown) => {
  const d = parseOrThrow(z.object({ reason: optionalText(300) }), input ?? {});
  return move(ctx, id, 'CANCELLED', { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED'], permission: 'inventory.purchase', action: AuditActions.purchaseOrderCancelled, reason: d.reason });
};

/**
 * Stop waiting for what has not arrived. Anything still outstanding is written off the order (kept on the record as
 * "cancelled") and the order closes as Received. Only possible once something has actually been received.
 */
export async function closePurchaseOrderShort(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'inventory.receive');
  requireFeature(ctx.subscription, 'purchase_orders');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(z.object({ reason: z.string().trim().min(3, 'Say why the rest will not be delivered').max(300) }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const po = await loadPo(tx, ctx, id, { lock: true });
    if (po.status !== 'PARTIALLY_RECEIVED') throw Errors.conflict('Only a partially received order can be closed short.');
    const written: { line: number; quantity: number }[] = [];
    for (const l of po.lines) {
      const rem = outstandingOf(l);
      if (rem > 0) {
        await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { quantityCancelled: l.quantityCancelled + rem } });
        written.push({ line: l.position, quantity: rem });
      }
    }
    await tx.purchaseOrder.update({ where: { id }, data: { status: 'RECEIVED', closedAt: new Date(), closedShort: true, updatedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.purchaseOrderClosedShort, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'purchase_order', resourceId: id, metadata: { number: po.number, reason: d.reason, written } });
    return { id, status: 'RECEIVED' as const };
  });
}

// ───────── Reading ─────────

export async function listPurchaseOrders(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(poListSchema, query);
  const costs = canSeeCosts(ctx);
  const statuses = q.status ? q.status.split(',').map((s) => s.trim().toUpperCase()) : null;
  return withTenant(ctx.business.id, async (tx) => {
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    if (q.locationId && !locs.includes(q.locationId)) throw Errors.validation({ locationId: 'Choose a location you have access to.' });
    const today = todayIso(ctx.business.timezone);
    const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 4);
    const where = {
      businessId: ctx.business.id,
      locationId: q.locationId ? q.locationId : { in: locs },
      ...(q.supplierId ? { supplierId: q.supplierId } : {}),
      ...(statuses ? { status: { in: statuses as never[] } } : {}),
      ...(q.open ? { status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] as never[] } } : {}),
      ...(q.late ? { status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] as never[] }, expectedDate: { lt: dateOnly(today) } } : {}),
      ...(q.from || q.to ? { poDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
      AND: words.map((w) => ({ OR: [{ number: { contains: w, mode: 'insensitive' as const } }, { supplier: { name: { contains: w, mode: 'insensitive' as const } } }] })),
    };
    void escapeLike;
    const total = await tx.purchaseOrder.count({ where });
    const rows = await tx.purchaseOrder.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      include: { supplier: { select: { id: true, name: true } }, lines: { select: { quantityOrdered: true, quantityReceived: true, quantityCancelled: true } } },
    });
    const locNames = new Map((await accessibleLocations(tx, ctx)).map((l) => [l.id, l.name]));
    return {
      items: rows.map((o) => ({
        id: o.id, number: o.number, status: o.status, supplierId: o.supplier.id, supplierName: o.supplier.name, locationName: locNames.get(o.locationId) ?? '', poDate: isoOf(o.poDate), expectedDate: isoOf(o.expectedDate),
        late: !!o.expectedDate && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status) && isoOf(o.expectedDate)! < today,
        ordered: o.lines.reduce((s, l) => s + l.quantityOrdered, 0), received: o.lines.reduce((s, l) => s + l.quantityReceived, 0), totalCents: costs ? o.totalCents : null, requiresApproval: o.requiresApproval,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function getPurchaseOrder(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, id);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const po = await loadPo(tx, ctx, id);
    const [supplier, receipts, partRows, returns, locs] = [
      await tx.supplier.findFirstOrThrow({ where: { id: po.supplierId, businessId: ctx.business.id } }),
      await tx.goodsReceipt.findMany({ where: { businessId: ctx.business.id, purchaseOrderId: id }, orderBy: { receivedAt: 'desc' }, include: { lines: true } }),
      await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: po.lines.map((l) => l.partId).filter((v): v is string => !!v) } }, select: { id: true, sku: true, name: true } }),
      await tx.supplierReturn.findMany({ where: { businessId: ctx.business.id, purchaseOrderId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, createdAt: true, reason: true } }),
      await accessibleLocations(tx, ctx),
    ];
    const parts = new Map(partRows.map((p) => [p.id, p]));
    const names = await userNames(tx, [po.createdById, po.approvedById, po.orderedById, ...receipts.map((r) => r.receivedById)]);
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const today = todayIso(ctx.business.timezone);
    return {
      order: {
        id: po.id, number: po.number, status: po.status, supplierId: po.supplierId, locationId: po.locationId, locationName: locs.find((l) => l.id === po.locationId)?.name ?? '', poDate: isoOf(po.poDate), expectedDate: isoOf(po.expectedDate),
        notes: po.notes, internalNotes: po.internalNotes, terms: po.terms, vatRegistered: po.vatRegistered, vatRateBps: po.vatRateBps,
        subtotalCents: costs ? po.subtotalCents : null, vatCents: costs ? po.vatCents : null, totalCents: costs ? po.totalCents : null, requiresApproval: po.requiresApproval || needsApproval(settings, po.totalCents),
        submittedAt: po.submittedAt, approvedAt: po.approvedAt, approvedByName: po.approvedById ? (names.get(po.approvedById) ?? null) : null, rejectedReason: po.rejectedReason, orderedAt: po.orderedAt, orderedByName: po.orderedById ? (names.get(po.orderedById) ?? null) : null,
        sentToSupplierAt: po.sentToSupplierAt, closedAt: po.closedAt, closedShort: po.closedShort, cancelledAt: po.cancelledAt, cancelReason: po.cancelReason, createdAt: po.createdAt, createdByName: po.createdById ? (names.get(po.createdById) ?? null) : null,
        late: !!po.expectedDate && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status) && isoOf(po.expectedDate)! < today,
      },
      supplier: { id: supplier.id, name: supplier.name, email: supplier.email, phone: supplier.phone, contactPerson: supplier.contactPerson },
      lines: po.lines.map((l) => ({
        id: l.id, position: l.position, partId: l.partId, sku: l.partId ? (parts.get(l.partId)?.sku ?? null) : null, description: l.description, supplierPartNumber: l.supplierPartNumber, quantityOrdered: l.quantityOrdered, quantityReceived: l.quantityReceived, quantityDamaged: l.quantityDamaged,
        quantityCancelled: l.quantityCancelled, remaining: outstandingOf(l), taxTreatment: l.taxTreatment, unitCostCents: costs ? l.unitCostCents : null, subtotalCents: costs ? l.subtotalCents : null, vatCents: costs ? l.vatCents : null, totalCents: costs ? l.totalCents : null,
      })),
      receipts: receipts.map((r) => ({ id: r.id, number: r.number, receivedAt: r.receivedAt, deliveryNoteRef: r.deliveryNoteRef, notes: r.notes, receivedByName: r.receivedById ? (names.get(r.receivedById) ?? null) : null, lines: r.lines.map((l) => ({ id: l.id, poLineId: l.poLineId, description: l.description, expected: l.quantityExpected, received: l.quantityReceived, damaged: l.quantityDamaged, incorrect: l.quantityIncorrect, notDelivered: l.quantityMissing, returned: l.quantityReturned, unitCostCents: costs ? l.unitCostCents : null, notes: l.notes })) })),
      returns,
      canSeeCosts: costs,
      can: {
        edit: can(ctx, 'inventory.purchase') && po.status === 'DRAFT',
        submit: can(ctx, 'inventory.purchase') && po.status === 'DRAFT' && needsApproval(settings, po.totalCents),
        approve: can(ctx, 'inventory.approve_purchase') && po.status === 'PENDING_APPROVAL',
        order: can(ctx, 'inventory.purchase') && (po.status === 'APPROVED' || (po.status === 'DRAFT' && !needsApproval(settings, po.totalCents))),
        receive: can(ctx, 'inventory.receive') && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status),
        cancel: can(ctx, 'inventory.purchase') && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED'].includes(po.status),
        closeShort: can(ctx, 'inventory.receive') && po.status === 'PARTIALLY_RECEIVED',
        send: can(ctx, 'inventory.purchase') && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status),
        returns: can(ctx, 'inventory.return'),
      },
    };
  });
}

/** Email the order to the supplier (only when someone chooses to). The PDF is attached; nothing is sent automatically. */
export async function emailPurchaseOrder(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'inventory.purchase');
  requirePermission(ctx, 'inventory.view_costs'); // the PDF carries the agreed costs
  requireFeature(ctx.subscription, 'purchase_orders');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  await withTenant(ctx.business.id, async (tx) => {
    const po = await loadPo(tx, ctx, id);
    if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw Errors.conflict('Place the order before sending it to the supplier.');
  });
  // The PDF is a stored document (one store for every file): made once when the order is placed, then reused for every send.
  const doc = await generateDocument(ctx.business.id, ctx.user.id, 'purchase_order', id, { meta: ctx.meta });
  return withTenant(ctx.business.id, async (tx) => {
    const po = await loadPo(tx, ctx, id, { lock: true });
    if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw Errors.conflict('Place the order before sending it to the supplier.');
    const supplier = await tx.supplier.findFirstOrThrow({ where: { id: po.supplierId, businessId: ctx.business.id } });
    if (!supplier.email) throw Errors.validation({ email: 'This supplier has no email address. Add one on the supplier first.' });
    const loc = await tx.location.findFirst({ where: { id: po.locationId, businessId: ctx.business.id }, select: { name: true } });
    const fmt = (c: number) => formatMoney(c, ctx.business.currency, ctx.business.locale);
    const out = await sendCustomerMessage(tx, ctx.business.id, {
      event: 'PURCHASE_ORDER_SENT', contact: { email: supplier.email, name: supplier.contactPerson || supplier.name }, entity: { type: 'purchase_order', id }, locationId: po.locationId,
      attachmentFileIds: [doc.file.id], dedupeKey: `po:${id}:send:${Date.now()}`,
      vars: {
        purchase_order_number: po.number, supplier_name: supplier.name, order_total: fmt(po.totalCents), deliver_to: loc?.name ?? ctx.business.name,
        expected_date: po.expectedDate ? formatDate(po.expectedDate, 'UTC', ctx.business.locale) : 'the earliest date you can manage',
        order_lines: po.lines.map((l) => `${l.quantityOrdered} x ${l.description}${l.supplierPartNumber ? ` (${l.supplierPartNumber})` : ''} @ ${fmt(l.unitCostCents)}`).join('\n'), note: po.notes ?? '',
      },
    });
    if (!out.some((o) => o.status === 'queued')) throw Errors.validation({ email: out[0]?.detail ?? 'The order could not be sent.' });
    await tx.purchaseOrder.update({ where: { id }, data: { sentToSupplierAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.purchaseOrderSent, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'purchase_order', resourceId: id, metadata: { number: po.number, to: supplier.email, fileId: doc.file.id } });
    return { sentTo: supplier.email };
  });
}

export { notifyPurchasing };
