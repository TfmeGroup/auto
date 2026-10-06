import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { adjustStock, listMovements, getPartStock } from '@/server/inventory/stock';
import { addJobPart, updateJobPart } from '@/server/jobcards/items';
import { updateInventorySettings } from '@/server/inventory/settings';
import { createPart, getPart, listParts, findPartByCode, setPartStatus } from '@/server/inventory/parts';
import { ownerQuery, type TestWorkspace } from '../helpers/factory';
import { idem, invWorkspace, ledger, mkPart, openJob, stock } from '../helpers/inventory';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await invWorkspace('Stock Workshop');
});

const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

describe('stock quantities: on hand, reserved, available', () => {
  it('records an adjustment as a movement with before and after, and available = on hand - reserved', async () => {
    const p = await mkPart(ws);
    const r = await adjustStock(ws.ctx, { partId: p.id, kind: 'INCREASE', quantity: 20, reasonCode: 'OPENING_BALANCE', reason: 'Opening count' });
    expect(r).toMatchObject({ unchanged: false, before: 0, after: 20, onHand: 20, reserved: 0, available: 20 });
    expect(await ledger(ws, p.id)).toEqual([{ type: 'ADJUSTED', on_hand_delta: 20, reserved_delta: 0, on_hand_after: 20, reserved_after: 0 }]);
    const { job } = await openJob(ws);
    await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 5 });
    // reserved, not used: on hand is unchanged and the page cannot claim 20 are available
    expect(await stock(ws, p.id)).toEqual({ onHand: 20, reserved: 5, available: 15 });
    const view = await getPartStock(ws.ctx, p.id);
    expect(view).toMatchObject({ onHand: 20, reserved: 5, available: 15 });
  });

  it('reserve, then fit: the reservation is released and on hand drops once (no double decrement)', async () => {
    const p = await mkPart(ws, {}, 10);
    const { job } = await openJob(ws);
    const added = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 1 });
    expect(added.status).toBe('RESERVED');
    expect(await stock(ws, p.id)).toEqual({ onHand: 10, reserved: 1, available: 9 });
    await updateJobPart(ws.ctx, job.id, added.id, { status: 'FITTED' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 9, reserved: 0, available: 9 });
    const types = (await ledger(ws, p.id)).map((m) => m.type);
    expect(types).toEqual(['ADJUSTED', 'RESERVED', 'USED']);
    const used = (await ledger(ws, p.id))[2]!;
    expect(used).toMatchObject({ on_hand_delta: -1, reserved_delta: -1 });
    // fitting again changes nothing
    await updateJobPart(ws.ctx, job.id, added.id, { status: 'FITTED' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 9, reserved: 0, available: 9 });
  });

  it('an unused reservation is returned, a fitted part is returned to the shelf', async () => {
    const p = await mkPart(ws, {}, 4);
    const { job } = await openJob(ws);
    const a = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 2 });
    await updateJobPart(ws.ctx, job.id, a.id, { status: 'RETURNED' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 4, reserved: 0, available: 4 });
    const b = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 1, status: 'FITTED' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    await updateJobPart(ws.ctx, job.id, b.id, { status: 'RETURNED' });
    expect(await stock(ws, p.id)).toEqual({ onHand: 4, reserved: 0, available: 4 });
    expect((await ledger(ws, p.id)).map((m) => m.type)).toEqual(['ADJUSTED', 'RESERVED', 'UNRESERVED', 'USED', 'RETURNED']);
    // a returned line stays returned
    await rejects(updateJobPart(ws.ctx, job.id, b.id, { status: 'FITTED' }));
  });

  it('refuses to reserve or use more than is available, with a clear message', async () => {
    const p = await mkPart(ws, {}, 2);
    const { job } = await openJob(ws);
    const e = await rejects(addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 3, status: 'RESERVED' }));
    expect(e.message).toMatch(/Not enough stock/);
    expect(await stock(ws, p.id)).toEqual({ onHand: 2, reserved: 0, available: 2 });
    // auto-reserve falls back to "requested" and says how many are available
    const r = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 3 });
    expect(r.status).toBe('REQUESTED');
    expect((r as { unavailable: { available: number } | null }).unavailable).toEqual({ available: 2 });
  });

  it('a controlled adjustment needs a reason, can count stock, and cannot take available below zero', async () => {
    const p = await mkPart(ws, {}, 6);
    await rejects(adjustStock(ws.ctx, { partId: p.id, kind: 'DECREASE', quantity: 1, reasonCode: 'DAMAGED', reason: '' }));
    const damaged = await adjustStock(ws.ctx, { partId: p.id, kind: 'DECREASE', quantity: 1, reasonCode: 'DAMAGED', reason: 'Dropped on the floor' });
    expect(damaged).toMatchObject({ before: 6, after: 5 });
    expect((await ledger(ws, p.id)).map((m) => m.type)).toContain('DAMAGED');
    const counted = await adjustStock(ws.ctx, { partId: p.id, kind: 'COUNT', quantity: 8, reasonCode: 'STOCK_COUNT', reason: 'Cycle count' });
    expect(counted).toMatchObject({ before: 5, after: 8 });
    expect(await adjustStock(ws.ctx, { partId: p.id, kind: 'COUNT', quantity: 8, reasonCode: 'STOCK_COUNT', reason: 'Counted again' })).toMatchObject({ unchanged: true });
    const e = await rejects(adjustStock(ws.ctx, { partId: p.id, kind: 'DECREASE', quantity: 50, reasonCode: 'MISSING', reason: 'Gone' }));
    expect(e.message).toMatch(/Not enough stock/);
    expect((await stock(ws, p.id)).onHand).toBe(8);
  });

  it('cannot reduce on hand below what is reserved', async () => {
    const p = await mkPart(ws, {}, 5);
    const { job } = await openJob(ws);
    await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 4 });
    await rejects(adjustStock(ws.ctx, { partId: p.id, kind: 'DECREASE', quantity: 3, reasonCode: 'MISSING', reason: 'Missing from shelf' }));
    expect(await stock(ws, p.id)).toEqual({ onHand: 5, reserved: 4, available: 1 });
  });

  it('the same request key is applied once', async () => {
    const p = await mkPart(ws);
    const key = idem();
    const a = await adjustStock(ws.ctx, { partId: p.id, kind: 'INCREASE', quantity: 7, reasonCode: 'OTHER', reason: 'Delivery by hand', idempotencyKey: key });
    const b = await adjustStock(ws.ctx, { partId: p.id, kind: 'INCREASE', quantity: 7, reasonCode: 'OTHER', reason: 'Delivery by hand', idempotencyKey: key });
    expect((b as { replayed?: boolean }).replayed).toBe(true);
    expect((a as { movementId: string }).movementId).toBe((b as { movementId: string }).movementId);
    expect((await stock(ws, p.id)).onHand).toBe(7);
  });
});

describe('the database itself protects the stock', () => {
  it('refuses to edit a count directly, to insert one with stock, and to touch a movement', async () => {
    const p = await mkPart(ws, {}, 3);
    await expect(ownerQuery('UPDATE stock_levels SET on_hand = 99 WHERE part_id = $1', [p.id])).rejects.toThrow(/only through stock movements/);
    await expect(ownerQuery('DELETE FROM stock_levels WHERE part_id = $1', [p.id])).rejects.toThrow();
    await expect(ownerQuery('UPDATE stock_movements SET on_hand_delta = 50 WHERE part_id = $1', [p.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM stock_movements WHERE part_id = $1', [p.id])).rejects.toThrow();
    const loc = (await ownerQuery<{ id: string }>('SELECT id FROM locations WHERE business_id = $1 AND is_default', [ws.businessId])).rows[0]!.id;
    const q = await mkPart(ws);
    await expect(ownerQuery('INSERT INTO stock_levels (business_id, part_id, location_id, on_hand, updated_at) VALUES ($1, $2, $3, 5, now())', [ws.businessId, q.id, loc])).rejects.toThrow();
    expect((await stock(ws, p.id)).onHand).toBe(3);
  });

  it('a movement that would break the rules is refused even if inserted by hand', async () => {
    const p = await mkPart(ws, {}, 2);
    const loc = (await ownerQuery<{ id: string }>('SELECT id FROM locations WHERE business_id = $1 AND is_default', [ws.businessId])).rows[0]!.id;
    const raw = (type: string, on: number, res: number) =>
      ownerQuery('INSERT INTO stock_movements (business_id, part_id, location_id, type, on_hand_delta, reserved_delta) VALUES ($1, $2, $3, $4::stock_movement_type, $5, $6)', [ws.businessId, p.id, loc, type, on, res]);
    await expect(raw('USED', -5, 0)).rejects.toThrow(/not enough stock/);
    await expect(raw('UNRESERVED', 0, -1)).rejects.toThrow();
    await expect(raw('RECEIVED', -1, 0)).rejects.toThrow(); // shape check
    await raw('RECEIVED', 3, 0);
    expect((await stock(ws, p.id)).onHand).toBe(5);
  });

  it('every part\'s count equals the sum of its movements', async () => {
    const r = await ownerQuery<{ bad: number }>(
      `SELECT count(*)::int AS bad FROM stock_levels sl WHERE sl.business_id = $1 AND (
         sl.on_hand <> (SELECT COALESCE(sum(on_hand_delta), 0) FROM stock_movements m WHERE m.part_id = sl.part_id AND m.location_id = sl.location_id)
         OR sl.reserved <> (SELECT COALESCE(sum(reserved_delta), 0) FROM stock_movements m WHERE m.part_id = sl.part_id AND m.location_id = sl.location_id))`,
      [ws.businessId],
    );
    expect(r.rows[0]!.bad).toBe(0);
  });
});

describe('concurrent use of the last unit', () => {
  it('only one of two simultaneous requests gets the last part', async () => {
    const p = await mkPart(ws, {}, 1);
    const j1 = await openJob(ws);
    const j2 = await openJob(ws);
    const l1 = await addJobPart(ws.ctx, j1.job.id, { inventoryItemId: p.id, quantity: 1, status: 'REQUESTED' });
    const l2 = await addJobPart(ws.ctx, j2.job.id, { inventoryItemId: p.id, quantity: 1, status: 'REQUESTED' });
    const results = await Promise.allSettled([
      updateJobPart(ws.ctx, j1.job.id, l1.id, { status: 'FITTED' }),
      updateJobPart(ws.ctx, j2.job.id, l2.id, { status: 'FITTED' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(AppError);
    expect(await stock(ws, p.id)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  it('many simultaneous reservations never promise more than exists', async () => {
    const p = await mkPart(ws, {}, 3);
    const jobs = await Promise.all(Array.from({ length: 6 }, () => openJob(ws)));
    const lines = await Promise.all(jobs.map((j) => addJobPart(ws.ctx, j.job.id, { inventoryItemId: p.id, quantity: 1, status: 'REQUESTED' })));
    const settled = await Promise.allSettled(lines.map((l, i) => updateJobPart(ws.ctx, jobs[i]!.job.id, l.id, { status: 'RESERVED' })));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(3);
    expect(await stock(ws, p.id)).toEqual({ onHand: 3, reserved: 3, available: 0 });
  });
});

describe('negative stock', () => {
  it('is off by default, and when switched on is flagged and audited', async () => {
    const w = await invWorkspace('Negative Workshop');
    const p = await mkPart(w, {}, 1);
    const { job } = await openJob(w);
    const line = await addJobPart(w.ctx, job.id, { inventoryItemId: p.id, quantity: 2, status: 'REQUESTED' });
    await rejects(updateJobPart(w.ctx, job.id, line.id, { status: 'FITTED' }));
    await updateInventorySettings(w.ctx, { allowNegativeStock: true });
    await updateJobPart(w.ctx, job.id, line.id, { status: 'FITTED' });
    expect(await stock(w, p.id)).toEqual({ onHand: -1, reserved: 0, available: -1 });
    const flagged = await ownerQuery('SELECT 1 FROM stock_movements WHERE part_id = $1 AND went_negative', [p.id]);
    expect(flagged.rowCount).toBe(1);
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'stock.went_negative'", [w.businessId]);
    expect(audit.rowCount).toBeGreaterThan(0);
    const changed = await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'inventory.settings_changed'", [w.businessId]);
    expect(changed.rowCount).toBe(1);
  });
});

describe('the parts catalogue', () => {
  it('keeps SKUs unique (case-insensitively) and barcodes unique, as configured', async () => {
    const w = await invWorkspace('Identifier Workshop');
    await createPart(w.ctx, { sku: 'BP-100', name: 'Brake pads', barcode: '600123456' });
    const dupSku = await rejects(createPart(w.ctx, { sku: 'bp-100', name: 'Other' }));
    expect(dupSku.details).toMatchObject({ sku: expect.stringContaining('already used') });
    await rejects(createPart(w.ctx, { sku: 'BP-101', name: 'Other', barcode: '600123456' }));
    // part numbers may repeat until the business says otherwise
    await createPart(w.ctx, { sku: 'A1', name: 'A', partNumber: 'PN-1' });
    await createPart(w.ctx, { sku: 'A2', name: 'B', partNumber: 'PN-1' });
    await updateInventorySettings(w.ctx, { uniquePartNumber: false });
    await rejects(updateInventorySettings(w.ctx, { uniquePartNumber: true }));
    // an auto-generated SKU when none is given
    const auto = await createPart(w.ctx, { name: 'No SKU given' });
    expect(auto.sku).toMatch(/^P-\d{6}$/);
  });

  it('finds a part by SKU, part number, barcode, name, brand and supplier part number', async () => {
    const w = await invWorkspace('Search Workshop');
    const part = await createPart(w.ctx, { sku: 'OIL-5W30', partNumber: 'MF-5W30-5L', name: 'Synthetic engine oil 5W-30 5L', brand: 'Mobilex', barcode: '6009876543210' });
    await createPart(w.ctx, { sku: 'FIL-1', name: 'Oil filter', brand: 'Purolux' });
    const find = async (q: string) => (await listParts(w.ctx, { q })).items.map((i) => i.id);
    for (const q of ['OIL-5W30', 'mf-5w30', '6009876543210', 'synthetic engine', 'mobilex']) expect(await find(q)).toContain(part.id);
    expect(await find('oil purolux')).not.toContain(part.id);
    const byCode = await findPartByCode(w.ctx, '6009876543210');
    expect(byCode.items.map((i) => i.id)).toEqual([part.id]);
    expect((await findPartByCode(w.ctx, 'oil-5w30')).items).toHaveLength(1);
    expect((await findPartByCode(w.ctx, 'no-such-code')).items).toHaveLength(0);
    // wildcards are matched literally
    expect(await find('%')).toEqual([]);
    expect(await find('_')).toEqual([]);
  });

  it('paginates and filters by stock level', async () => {
    const w = await invWorkspace('Filter Workshop');
    const ok = await mkPart(w, { minStock: 2 }, 10);
    const low = await mkPart(w, { minStock: 5 }, 4);
    const out = await mkPart(w, { minStock: 1 }, 0);
    const ids = async (stockFilter: string) => (await listParts(w.ctx, { stock: stockFilter })).items.map((i) => i.id);
    expect(await ids('low')).toEqual([low.id]);
    expect(await ids('out')).toEqual([out.id]);
    expect((await ids('in')).sort()).toEqual([ok.id, low.id].sort());
    const page = await listParts(w.ctx, { pageSize: 2, page: 2, sort: 'sku' });
    expect(page.meta).toMatchObject({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(page.items).toHaveLength(1);
    expect((await listParts(w.ctx, { minAvailable: 5 })).items.map((i) => i.id)).toEqual([ok.id]);
    const s = (await listParts(w.ctx, { q: low.sku })).items[0]!;
    expect(s).toMatchObject({ onHand: 4, reserved: 0, available: 4, state: 'LOW' });
  });

  it('archives instead of deleting, and not while stock is held', async () => {
    const w = await invWorkspace('Archive Workshop');
    const withStock = await mkPart(w, {}, 2);
    await rejects(setPartStatus(w.ctx, withStock.id, 'ARCHIVED'));
    await setPartStatus(w.ctx, withStock.id, 'INACTIVE');
    const empty = await mkPart(w);
    await setPartStatus(w.ctx, empty.id, 'ARCHIVED');
    expect((await listParts(w.ctx, {})).items.map((i) => i.id)).not.toContain(empty.id);
    expect((await listParts(w.ctx, { status: 'ARCHIVED' })).items.map((i) => i.id)).toContain(empty.id);
    await expect(ownerQuery('DELETE FROM parts WHERE id = $1', [empty.id])).rejects.toThrow(/cannot be deleted/);
    // an inactive part cannot go on a new job
    const { job } = await openJob(w);
    await rejects(addJobPart(w.ctx, job.id, { inventoryItemId: withStock.id, quantity: 1 }));
    await setPartStatus(w.ctx, empty.id, 'ACTIVE');
    expect((await getPart(w.ctx, empty.id)).part.status).toBe('ACTIVE');
  });

  it('keeps a price history and audits cost and price changes', async () => {
    const w = await invWorkspace('Price Workshop');
    const p = await mkPart(w, { costCents: 10_000, sellPriceCents: 15_000 });
    const { updatePart, listPartPrices } = await import('@/server/inventory/parts');
    await updatePart(w.ctx, p.id, { costCents: 11_000, reason: 'Supplier increase' });
    await updatePart(w.ctx, p.id, { sellPriceCents: 16_500 });
    const h = await listPartPrices(w.ctx, p.id, {});
    expect(h.items).toHaveLength(3);
    expect(h.items[0]).toMatchObject({ previousSellCents: 15_000, newSellCents: 16_500 });
    expect(h.items[1]).toMatchObject({ previousCostCents: 10_000, newCostCents: 11_000, reason: 'Supplier increase' });
    await expect(ownerQuery('UPDATE part_price_history SET new_cost_cents = 1 WHERE part_id = $1', [p.id])).rejects.toThrow();
    const a = await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'part.price_changed' AND resource_id = $2", [w.businessId, p.id]);
    expect(a.rowCount).toBe(2);
  });
});

describe('movement history', () => {
  it('lists movements newest first, paginated, filtered by type and part', async () => {
    const w = await invWorkspace('Ledger Workshop');
    const p = await mkPart(w, {}, 10);
    const { job } = await openJob(w);
    await addJobPart(w.ctx, job.id, { inventoryItemId: p.id, quantity: 2 });
    const all = await listMovements(w.ctx, { partId: p.id });
    expect(all.items.map((m) => m.type)).toEqual(['RESERVED', 'ADJUSTED']);
    expect(all.items[0]).toMatchObject({ jobNumber: job.jobNumber, onHandAfter: 10, reservedAfter: 2, by: expect.any(String) });
    expect((await listMovements(w.ctx, { partId: p.id, type: 'ADJUSTED' })).items).toHaveLength(1);
    expect((await listMovements(w.ctx, { partId: p.id, pageSize: 1, page: 2 })).items).toHaveLength(1);
  });
});
