import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { vatOnExclusive } from '@/lib/money';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { costAfterReceipt, orderStatusAfterReceipt, outstandingOf } from './calc';
import { accessibleLocations, actorOf, canSeeCosts, loadInventorySettings, lockInventoryRow, nextInventoryNumber, resolveLocation } from './common';
import { notifyPurchasing } from './purchasing';
import { recordPriceChange } from './parts';
import { applyMovement } from './stock';

/**
 * Goods receiving and returns to suppliers.
 *
 * A delivery is one immutable receipt. For each line: the good units go onto the shelf (one RECEIVED movement, at the price
 * actually paid), damaged units are recorded but NEVER become usable stock, and wrong items are recorded and refused. Anything
 * not delivered stays outstanding on the order, so an order is only "Received" when nothing is left to arrive (or the business
 * deliberately closes it short). A mistake is corrected with a supplier return or an adjustment, never by editing the receipt.
 */

const line = z.object({
  poLineId: uuidSchema,
  quantityReceived: z.coerce.number().int().min(0).max(1_000_000).default(0),
  quantityDamaged: z.coerce.number().int().min(0).max(1_000_000).default(0),
  quantityIncorrect: z.coerce.number().int().min(0).max(1_000_000).default(0),
  /** The price actually charged per unit, if it differs from the order. */
  unitCostCents: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
  notes: optionalText(300),
});

export const receiveSchema = z.object({
  locationId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  deliveryNoteRef: optionalText(80),
  notes: optionalText(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  lines: z.array(line).min(1).max(200),
});

export async function receiveGoods(ctx: BusinessContext, poId: string, input: unknown) {
  requirePermission(ctx, 'inventory.receive');
  requireFeature(ctx.subscription, 'purchase_orders');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, poId);
  const d = parseOrThrow(receiveSchema, input);
  const costsAllowed = canSeeCosts(ctx);
  if (d.lines.some((l) => l.unitCostCents !== undefined) && !costsAllowed) throw Errors.forbidden('You do not have permission to enter costs.');

  return withTenant(ctx.business.id, async (tx) => {
    await lockInventoryRow(tx, 'purchase_orders', ctx.business.id, poId);
    // The same delivery sent twice (a double tap, a retry) is one delivery.
    if (d.idempotencyKey) {
      const prior = await tx.goodsReceipt.findFirst({ where: { businessId: ctx.business.id, idempotencyKey: d.idempotencyKey } });
      if (prior) return { receiptId: prior.id, number: prior.number, replayed: true as const, orderStatus: (await tx.purchaseOrder.findFirstOrThrow({ where: { id: prior.purchaseOrderId, businessId: ctx.business.id }, select: { status: true } })).status };
    }
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const po = await tx.purchaseOrder.findFirst({ where: { id: poId, businessId: ctx.business.id, locationId: { in: locs } }, include: { lines: { orderBy: { position: 'asc' } } } });
    if (!po) throw Errors.notFound('Purchase order');
    if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw Errors.conflict(po.status === 'RECEIVED' ? 'This order has already been received in full.' : 'Only an order that has been placed can be received.');
    const locationId = await resolveLocation(tx, ctx, d.locationId ?? po.locationId);
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const byLine = new Map(po.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    const work: { l: (typeof po.lines)[number]; in: z.output<typeof line>; cost: number; expected: number }[] = [];
    for (const i of d.lines) {
      const l = byLine.get(i.poLineId);
      if (!l) throw Errors.validation({ lines: 'A line you sent is not on this order.' });
      if (seen.has(l.id)) throw Errors.validation({ lines: 'A line appears twice.' });
      seen.add(l.id);
      const handled = i.quantityReceived + i.quantityDamaged + i.quantityIncorrect;
      if (handled === 0) continue;
      const expected = outstandingOf(l);
      if (handled > expected) throw Errors.validation({ lines: `Line ${l.position} (${l.description}): ${handled} is more than the ${expected} still expected.` });
      work.push({ l, in: i, cost: i.unitCostCents ?? l.unitCostCents, expected });
    }
    if (work.length === 0) throw Errors.validation({ lines: 'Enter what was delivered on at least one line.' });

    const number = await nextInventoryNumber(tx, ctx.business.id, 'goods_receipt', settings, po.locationId);
    const receipt = await tx.goodsReceipt.create({
      data: { businessId: ctx.business.id, number, purchaseOrderId: po.id, supplierId: po.supplierId, locationId, deliveryNoteRef: d.deliveryNoteRef ?? null, notes: d.notes ?? null, idempotencyKey: d.idempotencyKey ?? null, receivedById: ctx.user.id },
    });

    // Stock rows are locked in a fixed order so two deliveries touching the same parts cannot deadlock.
    const ordered = [...work].sort((a, b) => (a.l.partId ?? '').localeCompare(b.l.partId ?? ''));
    const damagedAny: string[] = [];
    for (const w of ordered) {
      const { l, in: i, cost, expected } = w;
      const vat = po.vatRegistered && l.taxTreatment === 'STANDARD' ? vatOnExclusive(i.quantityReceived * cost, po.vatRateBps) : 0;
      const rl = await tx.goodsReceiptLine.create({
        data: {
          businessId: ctx.business.id, receiptId: receipt.id, poLineId: l.id, partId: l.partId, description: l.description, quantityExpected: expected, quantityReceived: i.quantityReceived, quantityDamaged: i.quantityDamaged,
          quantityIncorrect: i.quantityIncorrect, quantityMissing: Math.max(0, expected - i.quantityReceived - i.quantityDamaged - i.quantityIncorrect), unitCostCents: cost, vatCents: vat, notes: i.notes ?? null,
        },
      });
      if (l.partId) {
        if (i.quantityReceived > 0) {
          const part = await tx.part.findFirstOrThrow({ where: { id: l.partId, businessId: ctx.business.id } });
          const levels = await tx.stockLevel.aggregate({ where: { businessId: ctx.business.id, partId: l.partId }, _sum: { onHand: true } });
          await applyMovement(
            tx, actorOf(ctx),
            { partId: l.partId, locationId, type: 'RECEIVED', onHandDelta: i.quantityReceived, unitCostCents: cost, referenceType: 'goods_receipt', referenceId: receipt.id, purchaseOrderId: po.id, receiptId: receipt.id, idempotencyKey: `grn:${receipt.id}:${rl.id}`, reason: `Delivery ${number} for ${po.number}` },
            { settings },
          );
          // The part's current cost follows the business's cost method; the price actually paid stays on the receipt line forever.
          const newCost = costAfterReceipt(settings.costMethod, { onHand: levels._sum.onHand ?? 0, costCents: part.costCents }, i.quantityReceived, cost);
          if (newCost !== part.costCents) {
            await tx.part.update({ where: { id: part.id }, data: { costCents: newCost, updatedById: ctx.user.id } });
            await recordPriceChange(tx, ctx.business.id, ctx.user.id, part.id, { previousCost: part.costCents, newCost, previousSell: part.sellPriceCents, newSell: part.sellPriceCents, source: 'RECEIPT', reason: `${number} (${po.number})` });
          }
        }
        if (i.quantityDamaged > 0) {
          damagedAny.push(l.description);
          await applyMovement(tx, actorOf(ctx), { partId: l.partId, locationId, type: 'DAMAGED', onHandDelta: 0, unitCostCents: cost, referenceType: 'goods_receipt', referenceId: receipt.id, purchaseOrderId: po.id, receiptId: receipt.id, reasonCode: 'DAMAGED_ON_RECEIPT', reason: `${i.quantityDamaged} damaged on delivery ${number}; not added to stock`, idempotencyKey: `grn:${receipt.id}:${rl.id}:dmg` }, { settings });
        }
      } else if (i.quantityDamaged > 0) damagedAny.push(l.description);
      await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { quantityReceived: l.quantityReceived + i.quantityReceived, quantityDamaged: l.quantityDamaged + i.quantityDamaged } });
    }

    const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id, businessId: ctx.business.id } });
    const status = orderStatusAfterReceipt(lines);
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status, updatedById: ctx.user.id, ...(status === 'RECEIVED' ? { closedAt: new Date() } : {}) } });
    await recordAudit(tx, ctx.meta, {
      action: status === 'RECEIVED' ? AuditActions.purchaseOrderReceived : AuditActions.purchaseOrderPartiallyReceived, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'purchase_order', resourceId: po.id,
      before: { status: po.status }, after: { status }, metadata: { number: po.number, receipt: number, locationId, lines: work.map((w) => ({ line: w.l.position, received: w.in.quantityReceived, damaged: w.in.quantityDamaged, incorrect: w.in.quantityIncorrect, unitCostCents: w.cost })) },
    });
    const url = `/purchase-orders/${po.id}`;
    await notifyPurchasing(tx, ctx, [po.createdById, po.orderedById], {
      type: damagedAny.length ? 'PO_DAMAGED' : status === 'RECEIVED' ? 'PO_RECEIVED' : 'PO_PARTIALLY_RECEIVED',
      title: damagedAny.length ? `Damaged goods on ${po.number}` : status === 'RECEIVED' ? `Purchase order ${po.number} received` : `Partial delivery on ${po.number}`,
      body: damagedAny.length ? `${ctx.user.name} received delivery ${number} for ${po.number}. Damaged: ${damagedAny.join(', ')}. Damaged units were not added to stock.` : status === 'RECEIVED' ? `${ctx.user.name} received the last of ${po.number} (delivery ${number}).` : `${ctx.user.name} received part of ${po.number} (delivery ${number}). The rest is still on order.`,
      url,
    });
    return { receiptId: receipt.id, number, replayed: false as const, orderStatus: status };
  });
}

// ───────── Deliveries list ─────────

export async function listReceipts(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(paginationSchema.extend({ supplierId: uuidSchema.optional() }), query);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const where = { businessId: ctx.business.id, locationId: { in: locs }, ...(q.supplierId ? { supplierId: q.supplierId } : {}) };
    const total = await tx.goodsReceipt.count({ where });
    const rows = await tx.goodsReceipt.findMany({ where, orderBy: { receivedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lines: true, order: { select: { number: true, id: true } } } });
    const suppliers = new Map((await tx.supplier.findMany({ where: { businessId: ctx.business.id, id: { in: [...new Set(rows.map((r) => r.supplierId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return {
      items: rows.map((r) => ({ id: r.id, number: r.number, receivedAt: r.receivedAt, orderId: r.order.id, orderNumber: r.order.number, supplierName: suppliers.get(r.supplierId) ?? '', received: r.lines.reduce((s, l) => s + l.quantityReceived, 0), damaged: r.lines.reduce((s, l) => s + l.quantityDamaged, 0), valueCents: costs ? r.lines.reduce((s, l) => s + l.quantityReceived * l.unitCostCents, 0) : null })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

// ───────── Returns to a supplier ─────────

const returnLine = z.object({
  partId: uuidSchema,
  receiptLineId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : null)),
  quantity: z.coerce.number().int().min(1, 'At least 1').max(1_000_000),
  reason: optionalText(200),
});

export const supplierReturnSchema = z.object({
  supplierId: uuidSchema.optional(),
  locationId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  reason: z.string().trim().min(3, 'Say why the goods are going back').max(300),
  notes: optionalText(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  lines: z.array(returnLine).min(1).max(100),
});

/**
 * Send goods back to the supplier. The original delivery record is never touched: a return is its own record, and the stock
 * leaves through a SUPPLIER_RETURN movement (so it cannot be returned from nothing). When a line names the delivery line it came
 * from, no more than was received (less what has already gone back) can be returned against it.
 */
export async function createSupplierReturn(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.return');
  requireFeature(ctx.subscription, 'purchase_orders');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(supplierReturnSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    if (d.idempotencyKey) {
      const prior = await tx.supplierReturn.findFirst({ where: { businessId: ctx.business.id, idempotencyKey: d.idempotencyKey } });
      if (prior) return { id: prior.id, number: prior.number, replayed: true as const };
    }
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const locationId = await resolveLocation(tx, ctx, d.locationId);
    const receiptLineIds = d.lines.map((l) => l.receiptLineId).filter((v): v is string => !!v);
    const receiptLines = await tx.goodsReceiptLine.findMany({ where: { businessId: ctx.business.id, id: { in: receiptLineIds } }, include: { receipt: { select: { id: true, supplierId: true, purchaseOrderId: true } } } });
    if (receiptLines.length !== new Set(receiptLineIds).size) throw Errors.validation({ lines: 'A line refers to a delivery that is not in this business.' });
    const rlById = new Map(receiptLines.map((r) => [r.id, r]));
    const supplierIds = new Set(receiptLines.map((r) => r.receipt.supplierId));
    if (d.supplierId) supplierIds.add(d.supplierId);
    if (supplierIds.size !== 1) throw Errors.validation({ supplierId: supplierIds.size === 0 ? 'Choose the supplier the goods go back to.' : 'One return goes to one supplier.' });
    const supplierId = [...supplierIds][0]!;
    if (!(await tx.supplier.findFirst({ where: { id: supplierId, businessId: ctx.business.id }, select: { id: true } }))) throw Errors.validation({ supplierId: 'Choose a supplier of this business.' });
    const orderIds = new Set(receiptLines.map((r) => r.receipt.purchaseOrderId));
    const receiptIds = new Set(receiptLines.map((r) => r.receipt.id));

    // Per delivery line, never return more than came in (counting what was returned already, and within this same return).
    const asked = new Map<string, number>();
    for (const l of d.lines) {
      if (!l.receiptLineId) continue;
      const rl = rlById.get(l.receiptLineId)!;
      if (rl.partId !== l.partId) throw Errors.validation({ lines: 'A returned part does not match its delivery line.' });
      asked.set(rl.id, (asked.get(rl.id) ?? 0) + l.quantity);
      if (asked.get(rl.id)! > rl.quantityReceived - rl.quantityReturned) throw Errors.validation({ lines: `Only ${rl.quantityReceived - rl.quantityReturned} of "${rl.description}" can still be returned against that delivery.` });
    }

    const number = await nextInventoryNumber(tx, ctx.business.id, 'supplier_return', settings);
    const ret = await tx.supplierReturn.create({
      data: { businessId: ctx.business.id, number, supplierId, locationId, receiptId: receiptIds.size === 1 ? [...receiptIds][0]! : null, purchaseOrderId: orderIds.size === 1 ? [...orderIds][0]! : null, reason: d.reason, notes: d.notes ?? null, idempotencyKey: d.idempotencyKey ?? null, createdById: ctx.user.id },
    });
    const sorted = [...d.lines].sort((a, b) => a.partId.localeCompare(b.partId));
    for (const l of sorted) {
      const rl = l.receiptLineId ? rlById.get(l.receiptLineId)! : null;
      const part = await tx.part.findFirst({ where: { id: l.partId, businessId: ctx.business.id }, select: { id: true, costCents: true } });
      if (!part) throw Errors.validation({ lines: 'A returned part is not in your catalogue.' });
      const cost = rl ? rl.unitCostCents : part.costCents;
      const created = await tx.supplierReturnLine.create({ data: { businessId: ctx.business.id, returnId: ret.id, partId: l.partId, receiptLineId: rl?.id ?? null, quantity: l.quantity, unitCostCents: cost, reason: l.reason ?? null } });
      await applyMovement(tx, actorOf(ctx), { partId: l.partId, locationId, type: 'SUPPLIER_RETURN', onHandDelta: -l.quantity, unitCostCents: cost, referenceType: 'supplier_return', referenceId: ret.id, receiptId: rl?.receipt.id ?? null, purchaseOrderId: rl?.receipt.purchaseOrderId ?? null, reason: d.reason, idempotencyKey: `srt:${ret.id}:${created.id}` }, { settings });
      if (rl) await tx.goodsReceiptLine.update({ where: { id: rl.id }, data: { quantityReturned: { increment: l.quantity } } });
    }
    await recordAudit(tx, ctx.meta, { action: AuditActions.supplierReturnCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'supplier_return', resourceId: ret.id, metadata: { number, supplierId, reason: d.reason, locationId, lines: d.lines.map((l) => ({ partId: l.partId, quantity: l.quantity })) } });
    return { id: ret.id, number, replayed: false as const };
  });
}

export async function listSupplierReturns(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(paginationSchema.extend({ supplierId: uuidSchema.optional() }), query);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const where = { businessId: ctx.business.id, locationId: { in: locs }, ...(q.supplierId ? { supplierId: q.supplierId } : {}) };
    const total = await tx.supplierReturn.count({ where });
    const rows = await tx.supplierReturn.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lines: true } });
    const suppliers = new Map((await tx.supplier.findMany({ where: { businessId: ctx.business.id, id: { in: [...new Set(rows.map((r) => r.supplierId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return {
      items: rows.map((r) => ({ id: r.id, number: r.number, createdAt: r.createdAt, supplierName: suppliers.get(r.supplierId) ?? '', reason: r.reason, units: r.lines.reduce((s, l) => s + l.quantity, 0), valueCents: costs ? r.lines.reduce((s, l) => s + l.quantity * (l.unitCostCents ?? 0), 0) : null })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

