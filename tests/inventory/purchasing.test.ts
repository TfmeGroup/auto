import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { updateInventorySettings } from '@/server/inventory/settings';
import { approvePurchaseOrder, cancelPurchaseOrder, closePurchaseOrderShort, createPurchaseOrder, emailPurchaseOrder, getPurchaseOrder, listPurchaseOrders, placePurchaseOrder, rejectPurchaseOrder, submitPurchaseOrder, updatePurchaseOrder } from '@/server/inventory/purchasing';
import { purchaseOrderPdf } from '@/server/inventory/po-pdf';
import { receiveGoods, createSupplierReturn, listReceipts } from '@/server/inventory/receiving';
import { getPart, listPartPurchases } from '@/server/inventory/parts';
import { getSupplier, supplierPurchaseHistory } from '@/server/inventory/suppliers';
import { memberWithPermissions } from '../helpers/workshop';
import { drainJobs, ownerQuery, sentTo, type TestWorkspace } from '../helpers/factory';
import { pdfText } from '../helpers/finance';
import { idem, invWorkspace, ledger, mkPart, mkSupplier, placedOrder, receiveAll, stock } from '../helpers/inventory';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await invWorkspace('Purchasing Workshop');
});

const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

describe('purchase order numbering', () => {
  it('gives every order a unique, server-made number, even when many are created at once', async () => {
    const w = await invWorkspace('PO Numbers');
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const made = await Promise.all(Array.from({ length: 8 }, () => createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 1000 }] })));
    const numbers = made.map((m) => m.number);
    expect(new Set(numbers).size).toBe(8);
    for (const n of numbers) expect(n).toMatch(/^PO-\d{6}$/);
    // a number is never reused, even by an order that is cancelled
    const before = await createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 1000 }] });
    await cancelPurchaseOrder(w.ctx, before.id, {});
    const after = await createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 1000 }] });
    expect(after.number).not.toBe(before.number);
    const audit = await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND action = 'purchase_order.created'", [w.businessId]);
    expect(audit.rows[0]!.n).toBe(10);
  });

  it('uses the location code and the configured prefix', async () => {
    const w = await invWorkspace('PO Prefix');
    await ownerQuery("UPDATE locations SET doc_code = 'CPT' WHERE business_id = $1", [w.businessId]);
    await updateInventorySettings(w.ctx, { poPrefix: 'ord', numberPadding: 4 });
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const po = await createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 1000 }] });
    expect(po.number).toBe('ORD-CPT-0001');
  });
});

describe('totals and VAT', () => {
  it('calculates line and order totals on the server, ignoring any totals sent', async () => {
    const w = await invWorkspace('PO VAT');
    await ownerQuery('UPDATE businesses SET vat_registered = true, vat_rate_bps = 1500, vat_number = $2 WHERE id = $1', [w.businessId, '4123456789']);
    const { businessContext } = await import('../helpers/factory');
    w.ctx = await businessContext(w.owner);
    const s = await mkSupplier(w);
    const a = await mkPart(w);
    const b = await mkPart(w);
    const po = await createPurchaseOrder(w.ctx, { supplierId: s.id, totalCents: 1, lines: [{ partId: a.id, quantity: 3, unitCostCents: 10_000 }, { partId: b.id, quantity: 2, unitCostCents: 5_000, taxTreatment: 'ZERO_RATED' }] });
    const view = await getPurchaseOrder(w.ctx, po.id);
    expect(view.order).toMatchObject({ subtotalCents: 40_000, vatCents: 4_500, totalCents: 44_500 });
    expect(view.lines.map((l) => l.totalCents)).toEqual([34_500, 10_000]);
  });
});

describe('workflow and approvals', () => {
  it('lines can only change while the order is a draft (the database enforces it)', async () => {
    const s = await mkSupplier(ws);
    const p = await mkPart(ws);
    const po = await placedOrder(ws, s.id, [{ partId: p.id, quantity: 5 }]);
    await rejects(updatePurchaseOrder(ws.ctx, po.id, { lines: [{ partId: p.id, quantity: 9, unitCostCents: 1 }] }));
    await expect(ownerQuery('UPDATE purchase_order_lines SET quantity_ordered = 99 WHERE purchase_order_id = $1', [po.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('UPDATE purchase_order_lines SET unit_cost_cents = 1 WHERE purchase_order_id = $1', [po.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('DELETE FROM purchase_orders WHERE id = $1', [po.id])).rejects.toThrow(/cannot be deleted/);
    // statuses move only along the allowed lines
    await expect(ownerQuery("UPDATE purchase_orders SET status = 'DRAFT' WHERE id = $1", [po.id])).rejects.toThrow(/cannot go from/);
  });

  it('with approvals on, an order above the threshold cannot be placed until an approver approves it', async () => {
    const w = await invWorkspace('PO Approval');
    await updateInventorySettings(w.ctx, { poApprovalRequired: true, poApprovalThresholdCents: 50_000 });
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const buyer = await memberWithPermissions(w, ['inventory.view', 'inventory.view_costs', 'inventory.purchase']);
    const approver = await memberWithPermissions(w, ['inventory.view', 'inventory.view_costs', 'inventory.approve_purchase']);
    const big = await createPurchaseOrder(buyer.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 10, unitCostCents: 10_000 }] });
    const small = await createPurchaseOrder(buyer.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 10_000 }] });
    // below the threshold: no approval needed
    expect((await placePurchaseOrder(buyer.ctx, small.id)).status).toBe('ORDERED');
    // above it: cannot skip approval
    await rejects(placePurchaseOrder(buyer.ctx, big.id));
    await expect(ownerQuery("UPDATE purchase_orders SET status = 'ORDERED' WHERE id = $1", [big.id])).rejects.toThrow(/needs approval/);
    await rejects(submitPurchaseOrder(approver.ctx, big.id)); // the approver has no purchase permission
    expect((await submitPurchaseOrder(buyer.ctx, big.id)).status).toBe('PENDING_APPROVAL');
    await rejects(approvePurchaseOrder(buyer.ctx, big.id)); // the buyer cannot approve
    await rejects(updatePurchaseOrder(buyer.ctx, big.id, { notes: 'x' }));
    expect((await approvePurchaseOrder(approver.ctx, big.id)).status).toBe('APPROVED');
    expect((await placePurchaseOrder(buyer.ctx, big.id)).status).toBe('ORDERED');
    const view = await getPurchaseOrder(w.ctx, big.id);
    expect(view.order.approvedByName).toBeTruthy();
    const audit = (await ownerQuery("SELECT action FROM audit_logs WHERE business_id = $1 AND resource_id = $2 ORDER BY created_at", [w.businessId, big.id])).rows.map((r) => r.action);
    expect(audit).toEqual(['purchase_order.created', 'purchase_order.submitted', 'purchase_order.approved', 'purchase_order.ordered']);
  });

  it('a rejected order goes back to draft with the reason, and can be edited again', async () => {
    const w = await invWorkspace('PO Reject');
    await updateInventorySettings(w.ctx, { poApprovalRequired: true });
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const po = await createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 4, unitCostCents: 1000 }] });
    await submitPurchaseOrder(w.ctx, po.id);
    await rejectPurchaseOrder(w.ctx, po.id, { reason: 'Quantity too high' });
    const v = await getPurchaseOrder(w.ctx, po.id);
    expect(v.order).toMatchObject({ status: 'DRAFT', rejectedReason: 'Quantity too high' });
    await updatePurchaseOrder(w.ctx, po.id, { lines: [{ partId: p.id, quantity: 2, unitCostCents: 1000 }] });
    expect((await getPurchaseOrder(w.ctx, po.id)).lines[0]!.quantityOrdered).toBe(2);
  });

  it('an order needs lines, a supplier of this business and active parts', async () => {
    const w = await invWorkspace('PO Validation');
    const other = await invWorkspace('Other Business');
    const s = await mkSupplier(w);
    const foreignSupplier = await mkSupplier(other);
    const foreignPart = await mkPart(other);
    const p = await mkPart(w);
    await rejects(createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [] }));
    await rejects(createPurchaseOrder(w.ctx, { supplierId: foreignSupplier.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 100 }] }));
    await rejects(createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: foreignPart.id, quantity: 1, unitCostCents: 100 }] }));
    await rejects(createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 0, unitCostCents: 100 }] }));
    await rejects(createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: -5 }] }));
  });
});

describe('receiving goods', () => {
  it('partial delivery: 12 of 20 arrive, then the other 8; stock is never duplicated', async () => {
    const s = await mkSupplier(ws);
    const p = await mkPart(ws, { name: 'Brake pads' });
    const po = await placedOrder(ws, s.id, [{ partId: p.id, quantity: 20, unitCostCents: 25_000 }]);
    const line = po.lineIds[0]!;
    const r1 = await receiveAll(ws, po, { [line]: 12 });
    expect(r1.orderStatus).toBe('PARTIALLY_RECEIVED');
    expect(await stock(ws, p.id)).toEqual({ onHand: 12, reserved: 0, available: 12 });
    let v = await getPurchaseOrder(ws.ctx, po.id);
    expect(v.lines[0]).toMatchObject({ quantityOrdered: 20, quantityReceived: 12, remaining: 8 });
    await expect(ownerQuery("UPDATE purchase_orders SET status = 'RECEIVED' WHERE id = $1", [po.id])).rejects.toThrow(/outstanding/);
    const r2 = await receiveAll(ws, po, { [line]: 8 });
    expect(r2.orderStatus).toBe('RECEIVED');
    expect(await stock(ws, p.id)).toEqual({ onHand: 20, reserved: 0, available: 20 });
    v = await getPurchaseOrder(ws.ctx, po.id);
    expect(v.order.status).toBe('RECEIVED');
    expect(v.lines[0]).toMatchObject({ quantityReceived: 20, remaining: 0 });
    expect(v.receipts).toHaveLength(2);
    expect((await ledger(ws, p.id)).map((m) => m.type)).toEqual(['RECEIVED', 'RECEIVED']);
    // nothing more can be received
    await rejects(receiveAll(ws, po, { [line]: 1 }));
    expect((await stock(ws, p.id)).onHand).toBe(20);
  });

  it('refuses to receive more than is outstanding, and the same delivery sent twice counts once', async () => {
    const s = await mkSupplier(ws);
    const p = await mkPart(ws);
    const po = await placedOrder(ws, s.id, [{ partId: p.id, quantity: 10 }]);
    const line = po.lineIds[0]!;
    const e = await rejects(receiveAll(ws, po, { [line]: 11 }));
    expect(JSON.stringify(e.details)).toMatch(/more than the 10 still expected/);
    const key = idem();
    const a = await receiveGoods(ws.ctx, po.id, { idempotencyKey: key, lines: [{ poLineId: line, quantityReceived: 4 }] });
    const b = await receiveGoods(ws.ctx, po.id, { idempotencyKey: key, lines: [{ poLineId: line, quantityReceived: 4 }] });
    expect(b.replayed).toBe(true);
    expect(b.receiptId).toBe(a.receiptId);
    expect((await stock(ws, p.id)).onHand).toBe(4);
    // two simultaneous deliveries of the whole remainder: only one can be accepted
    const [x, y] = await Promise.allSettled([
      receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), lines: [{ poLineId: line, quantityReceived: 6 }] }),
      receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), lines: [{ poLineId: line, quantityReceived: 6 }] }),
    ]);
    expect([x, y].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await stock(ws, p.id)).onHand).toBe(10);
  });

  it('damaged goods are recorded but never become usable stock, and stay outstanding', async () => {
    const s = await mkSupplier(ws);
    const p = await mkPart(ws);
    const po = await placedOrder(ws, s.id, [{ partId: p.id, quantity: 20 }]);
    const line = po.lineIds[0]!;
    const r = await receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), deliveryNoteRef: 'DN-77', lines: [{ poLineId: line, quantityReceived: 18, quantityDamaged: 2, notes: 'Two boxes crushed' }] });
    expect(r.orderStatus).toBe('PARTIALLY_RECEIVED');
    expect((await stock(ws, p.id)).onHand).toBe(18);
    const v = await getPurchaseOrder(ws.ctx, po.id);
    expect(v.lines[0]).toMatchObject({ quantityReceived: 18, quantityDamaged: 2, remaining: 2 });
    expect(v.receipts[0]!.lines[0]).toMatchObject({ expected: 20, received: 18, damaged: 2, notDelivered: 0, notes: 'Two boxes crushed' });
    expect((await ledger(ws, p.id)).map((m) => m.type)).toEqual(['RECEIVED', 'DAMAGED']);
    expect((await ledger(ws, p.id))[1]).toMatchObject({ on_hand_delta: 0 });
    // the replacement units arrive later
    expect((await receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), lines: [{ poLineId: line, quantityReceived: 2 }] })).orderStatus).toBe('RECEIVED');
    expect((await stock(ws, p.id)).onHand).toBe(20);
  });

  it('records what was not delivered this time without counting it as received', async () => {
    const s = await mkSupplier(ws);
    const p = await mkPart(ws);
    const po = await placedOrder(ws, s.id, [{ partId: p.id, quantity: 10 }]);
    await receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), lines: [{ poLineId: po.lineIds[0]!, quantityReceived: 6, quantityIncorrect: 1 }] });
    const v = await getPurchaseOrder(ws.ctx, po.id);
    expect(v.receipts[0]!.lines[0]).toMatchObject({ expected: 10, received: 6, incorrect: 1, notDelivered: 3 });
    expect(v.lines[0]).toMatchObject({ quantityReceived: 6, remaining: 4 });
    expect((await stock(ws, p.id)).onHand).toBe(6);
  });

  it('keeps the price actually paid on each delivery, and the part cost follows the cost method', async () => {
    const w = await invWorkspace('Cost History');
    const s = await mkSupplier(w);
    const p = await mkPart(w, { costCents: 10_000 });
    const po1 = await placedOrder(w, s.id, [{ partId: p.id, quantity: 10, unitCostCents: 10_000 }]);
    await receiveAll(w, po1, { [po1.lineIds[0]!]: 10 });
    const po2 = await placedOrder(w, s.id, [{ partId: p.id, quantity: 10, unitCostCents: 11_000 }]);
    await receiveAll(w, po2, { [po2.lineIds[0]!]: 10 });
    // last-cost method: the catalogue cost follows the latest price; history keeps each one
    expect((await getPart(w.ctx, p.id)).part.costCents).toBe(11_000);
    const buys = await listPartPurchases(w.ctx, p.id, {});
    expect(buys.items.map((b) => b.unitCostCents)).toEqual([11_000, 10_000]);
    // a later price change never rewrites earlier receipts
    const { updatePart } = await import('@/server/inventory/parts');
    await updatePart(w.ctx, p.id, { costCents: 99_999 });
    expect((await listPartPurchases(w.ctx, p.id, {})).items.map((b) => b.unitCostCents)).toEqual([11_000, 10_000]);
    await expect(ownerQuery('UPDATE goods_receipt_lines SET unit_cost_cents = 1 WHERE part_id = $1', [p.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('DELETE FROM goods_receipt_lines WHERE part_id = $1', [p.id])).rejects.toThrow();

    await updateInventorySettings(w.ctx, { costMethod: 'AVERAGE_COST' });
    const p2 = await mkPart(w, { costCents: 0 }, 0);
    const a = await placedOrder(w, s.id, [{ partId: p2.id, quantity: 10, unitCostCents: 10_000 }]);
    await receiveAll(w, a, { [a.lineIds[0]!]: 10 });
    const b = await placedOrder(w, s.id, [{ partId: p2.id, quantity: 10, unitCostCents: 12_000 }]);
    await receiveAll(w, b, { [b.lineIds[0]!]: 10 });
    expect((await getPart(w.ctx, p2.id)).part.costCents).toBe(11_000);
  });

  it('needs the receive permission, and an order of another business is not found', async () => {
    const w = await invWorkspace('Receive Perms');
    const other = await invWorkspace('Receive Other');
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const po = await placedOrder(w, s.id, [{ partId: p.id, quantity: 3 }]);
    const viewer = await memberWithPermissions(w, ['inventory.view']);
    await rejects(receiveGoods(viewer.ctx, po.id, { lines: [{ poLineId: po.lineIds[0]!, quantityReceived: 1 }] }));
    await rejects(receiveGoods(other.ctx, po.id, { lines: [{ poLineId: po.lineIds[0]!, quantityReceived: 1 }] }));
    await rejects(getPurchaseOrder(other.ctx, po.id));
    expect((await stock(w, p.id)).onHand).toBe(0);
  });

  it('close short: stop waiting for the rest; cancelling after receipts is refused', async () => {
    const w = await invWorkspace('Close Short');
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const po = await placedOrder(w, s.id, [{ partId: p.id, quantity: 10 }]);
    await rejects(closePurchaseOrderShort(w.ctx, po.id, { reason: 'Nothing arrived yet' }));
    await receiveAll(w, po, { [po.lineIds[0]!]: 4 });
    await rejects(cancelPurchaseOrder(w.ctx, po.id, { reason: 'No' }));
    await expect(ownerQuery("UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = $1", [po.id])).rejects.toThrow(/already been received|cannot go from/);
    await closePurchaseOrderShort(w.ctx, po.id, { reason: 'Supplier is out of stock' });
    const v = await getPurchaseOrder(w.ctx, po.id);
    expect(v.order).toMatchObject({ status: 'RECEIVED', closedShort: true });
    expect(v.lines[0]).toMatchObject({ quantityReceived: 4, quantityCancelled: 6, remaining: 0 });
  });
});

describe('returns to a supplier', () => {
  it('takes stock back out through its own record, never beyond what was received, and keeps the receipt', async () => {
    const w = await invWorkspace('Supplier Returns');
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const po = await placedOrder(w, s.id, [{ partId: p.id, quantity: 10, unitCostCents: 20_000 }]);
    await receiveAll(w, po, { [po.lineIds[0]!]: 10 });
    const receiptLine = (await ownerQuery<{ id: string }>('SELECT id FROM goods_receipt_lines WHERE part_id = $1', [p.id])).rows[0]!.id;
    await rejects(createSupplierReturn(w.ctx, { reason: 'Wrong spec', lines: [{ partId: p.id, receiptLineId: receiptLine, quantity: 11 }] }));
    const r = await createSupplierReturn(w.ctx, { reason: 'Faulty batch', idempotencyKey: idem(), lines: [{ partId: p.id, receiptLineId: receiptLine, quantity: 3 }] });
    expect(r.number).toMatch(/^SRT-\d{6}$/);
    expect(await stock(w, p.id)).toEqual({ onHand: 7, reserved: 0, available: 7 });
    expect((await ledger(w, p.id)).map((m) => m.type)).toEqual(['RECEIVED', 'SUPPLIER_RETURN']);
    await rejects(createSupplierReturn(w.ctx, { reason: 'Again', lines: [{ partId: p.id, receiptLineId: receiptLine, quantity: 8 }] }));
    // the receipt is untouched: it still says 10 were received, 3 have gone back
    const rl = (await ownerQuery('SELECT quantity_received, quantity_returned FROM goods_receipt_lines WHERE id = $1', [receiptLine])).rows[0]!;
    expect(rl).toMatchObject({ quantity_received: 10, quantity_returned: 3 });
    await expect(ownerQuery('UPDATE supplier_returns SET reason = $2 WHERE id = $1', [r.id, 'x'])).rejects.toThrow();
    // cannot return stock that is not on the shelf
    const q = await mkPart(w);
    await rejects(createSupplierReturn(w.ctx, { supplierId: s.id, reason: 'Nothing here', lines: [{ partId: q.id, quantity: 1 }] }));
    const hist = await supplierPurchaseHistory(w.ctx, s.id, {});
    expect(hist.items).toHaveLength(1);
    expect((await getSupplier(w.ctx, s.id)).summary).toMatchObject({ orderCount: 1, returns: 1 });
    expect((await listReceipts(w.ctx, {})).items).toHaveLength(1);
  });
});

describe('cost visibility', () => {
  it('hides costs and totals from people without the cost permission', async () => {
    const w = await invWorkspace('PO Costs');
    const s = await mkSupplier(w);
    const p = await mkPart(w, { costCents: 12_345 });
    const po = await placedOrder(w, s.id, [{ partId: p.id, quantity: 2, unitCostCents: 12_345 }]);
    const tech = await memberWithPermissions(w, ['inventory.view']);
    const v = await getPurchaseOrder(tech.ctx, po.id);
    expect(v.order.totalCents).toBeNull();
    expect(v.lines[0]!.unitCostCents).toBeNull();
    expect((await getPart(tech.ctx, p.id)).part.costCents).toBeNull();
    expect((await listPurchaseOrders(tech.ctx, {})).items[0]!.totalCents).toBeNull();
    await rejects(purchaseOrderPdf(tech.ctx, po.id));
    const full = await getPurchaseOrder(w.ctx, po.id);
    expect(full.lines[0]!.unitCostCents).toBe(12_345);
  });
});

describe('purchase order documents', () => {
  it('renders a supplier PDF with the order, supplier and delivery location, and no customer information', async () => {
    const w = await invWorkspace('PO Document');
    const s = await mkSupplier(w, 'Brake Barn', { address: '12 Industry Rd', accountNumber: 'ACC-9' });
    const p = await mkPart(w, { name: 'Brake disc' });
    const po = await placedOrder(w, s.id, [{ partId: p.id, quantity: 4, unitCostCents: 80_000 }], { notes: 'Deliver to the back gate' });
    const { pdf, filename } = await purchaseOrderPdf(w.ctx, po.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(filename).toBe(`${po.number}.pdf`);
    const text = pdfText(pdf);
    for (const needle of ['PURCHASE ORDER', po.number, 'Brake Barn', 'Brake disc', 'SUPPLIER', 'Main workshop']) expect(text).toContain(needle);
    expect(text).not.toContain('BILL TO');
  });

  it('emails the order to the supplier with the PDF attached, only when asked', async () => {
    const w = await invWorkspace('PO Email');
    const s = await mkSupplier(w, 'Mailable Parts');
    const p = await mkPart(w);
    const po = await placedOrder(w, s.id, [{ partId: p.id, quantity: 2 }]);
    const { filename } = await purchaseOrderPdf(w.ctx, po.id);
    expect(sentTo('mailableparts@supplier.test')).toHaveLength(0);
    await emailPurchaseOrder(w.ctx, po.id);
    await drainJobs();
    const sent = sentTo('mailableparts@supplier.test');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain(po.number);
    expect(sent[0]!.attachments?.[0]).toMatchObject({ filename, contentType: 'application/pdf' });
    expect(Buffer.from(sent[0]!.attachments![0]!.contentBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    const draft = await (async () => {
      const { createPurchaseOrder } = await import('@/server/inventory/purchasing');
      return createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 100 }] });
    })();
    await rejects(emailPurchaseOrder(w.ctx, draft.id)); // not placed yet
  });
});
