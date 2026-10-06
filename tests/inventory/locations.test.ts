import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { adjustStock, getPartStock, listMovements } from '@/server/inventory/stock';
import { getPart, listParts } from '@/server/inventory/parts';
import { getInventoryDashboard, lowStockReport } from '@/server/inventory/reports';
import { updateInventorySettings } from '@/server/inventory/settings';
import { approveTransfer, cancelTransfer, createTransfer, getTransfer, listTransfers, receiveTransfer, requestTransfer, shipTransfer } from '@/server/inventory/transfers';
import { exportInventory } from '@/server/inventory/exports';
import { createPurchaseOrder } from '@/server/inventory/purchasing';
import { addJobPart } from '@/server/jobcards/items';
import { businessContext, createUser, ownerQuery, upgradePlan, userContext, type TestWorkspace } from '../helpers/factory';
import { addLocation, defaultLocationId, invWorkspace, mkPart, mkSupplier, openJob, stock } from '../helpers/inventory';
import { setActiveBusiness } from '@/server/auth/session';
import { prisma } from '@/server/db/client';

afterAll(disconnectPrisma);

const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

/** A member limited to the given locations (they hold the system "inventory staff" permissions). */
async function memberAt(ws: TestWorkspace, locationIds: string[], roleKey = 'inventory_staff') {
  const user = await createUser({ name: 'Located Member' });
  const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: roleKey } });
  const m = await prisma().membership.create({ data: { businessId: ws.businessId, userId: user.id, roleId: role.id, status: 'ACTIVE', joinedAt: new Date(), allLocations: false } });
  await withTenant(ws.businessId, async (tx) => {
    for (const locationId of locationIds) await tx.membershipLocation.create({ data: { membershipId: m.id, locationId } });
  });
  const uctx = await userContext(user);
  await setActiveBusiness(prisma(), uctx.sessionId, ws.businessId);
  return { user, ctx: await businessContext(user) };
}

let ws: TestWorkspace;
let A: string;
let B: string;
beforeAll(async () => {
  ws = await invWorkspace('Multi Location');
  A = await defaultLocationId(ws);
  B = await addLocation(ws, 'Second workshop');
});

describe('stock by location', () => {
  it('tracks stock per location, with totals over the locations the caller may use', async () => {
    const p = await mkPart(ws);
    await adjustStock(ws.ctx, { partId: p.id, locationId: A, kind: 'INCREASE', quantity: 10, reasonCode: 'OPENING_BALANCE', reason: 'Main workshop count' });
    await adjustStock(ws.ctx, { partId: p.id, locationId: B, kind: 'INCREASE', quantity: 4, reasonCode: 'OPENING_BALANCE', reason: 'Second workshop count' });
    const owner = await getPartStock(ws.ctx, p.id);
    expect(owner).toMatchObject({ onHand: 14, available: 14 });
    expect(owner.locations.map((l) => [l.locationName, l.onHand])).toEqual([['Main workshop', 10], ['Second workshop', 4]]);
    // a person who works at A only sees A's numbers everywhere, never B's
    const atA = await memberAt(ws, [A]);
    expect(await getPartStock(atA.ctx, p.id)).toMatchObject({ onHand: 10, available: 10 });
    const detail = await getPart(atA.ctx, p.id);
    expect(detail.stock.map((s) => s.locationName)).toEqual(['Main workshop']);
    expect(detail.part).toMatchObject({ onHand: 10, available: 10 });
    expect((await listParts(atA.ctx, { q: p.sku })).items[0]).toMatchObject({ onHand: 10 });
    expect(await listParts(atA.ctx, { q: p.sku, locationId: B }).then(() => null, (e: unknown) => e)).toBeInstanceOf(AppError);
    expect((await listMovements(atA.ctx, { partId: p.id })).items.map((m) => m.locationName)).toEqual(['Main workshop']);
    await rejects(listMovements(atA.ctx, { partId: p.id, locationId: B }));
    const dash = await getInventoryDashboard(atA.ctx, {});
    expect(dash.locations.map((l) => l.id)).toEqual([A]);
    await rejects(getInventoryDashboard(atA.ctx, { locationId: B }));
    // nor can they change B's stock
    await rejects(adjustStock(atA.ctx, { partId: p.id, locationId: B, kind: 'INCREASE', quantity: 50, reasonCode: 'OTHER', reason: 'Sneaky' }));
    expect(await stock(ws, p.id, B)).toMatchObject({ onHand: 4 });
    const low = await lowStockReport(atA.ctx, {});
    expect(low.find((r) => r.id === p.id)).toBeUndefined();
  });

  it('a job uses stock from its own location', async () => {
    const p = await mkPart(ws);
    await adjustStock(ws.ctx, { partId: p.id, locationId: B, kind: 'INCREASE', quantity: 3, reasonCode: 'OPENING_BALANCE', reason: 'B only' });
    const { job } = await openJob(ws, { locationId: B });
    const line = await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 2 });
    expect(line.status).toBe('RESERVED');
    expect(await stock(ws, p.id, B)).toMatchObject({ onHand: 3, reserved: 2 });
    expect(await stock(ws, p.id, A)).toMatchObject({ onHand: 0, reserved: 0 });
    // the main workshop has none, so a job there cannot reserve it
    const { job: jobA } = await openJob(ws, { locationId: A });
    const r = await addJobPart(ws.ctx, jobA.id, { inventoryItemId: p.id, quantity: 1 });
    expect(r.status).toBe('REQUESTED');
  });

  it('keeps a purchase order\'s delivery location and hides it from people without access', async () => {
    const s = await mkSupplier(ws);
    const p = await mkPart(ws);
    const po = await createPurchaseOrder(ws.ctx, { supplierId: s.id, locationId: B, lines: [{ partId: p.id, quantity: 2, unitCostCents: 100 }] });
    const atA = await memberAt(ws, [A]);
    const { getPurchaseOrder, listPurchaseOrders } = await import('@/server/inventory/purchasing');
    await rejects(getPurchaseOrder(atA.ctx, po.id));
    expect((await listPurchaseOrders(atA.ctx, {})).items.map((o) => o.id)).not.toContain(po.id);
    const atB = await memberAt(ws, [B]);
    expect((await getPurchaseOrder(atB.ctx, po.id)).order.number).toBe(po.number);
    void exportInventory;
  });
});

describe('stock transfers', () => {
  it('moves stock with paired movements: out at the source when it ships, in at the destination only when received', async () => {
    const p = await mkPart(ws, {}, 0);
    await adjustStock(ws.ctx, { partId: p.id, locationId: A, kind: 'INCREASE', quantity: 10, reasonCode: 'OPENING_BALANCE', reason: 'Seed' });
    const t = await createTransfer(ws.ctx, { fromLocationId: A, toLocationId: B, lines: [{ partId: p.id, quantity: 6 }], notes: 'For the weekend rush', submit: true });
    expect(t.number).toMatch(/^TRF-\d{6}$/);
    expect((await getTransfer(ws.ctx, t.id)).transfer.status).toBe('APPROVED'); // approval is not required by default
    expect(await stock(ws, p.id, A)).toMatchObject({ onHand: 10 });
    await shipTransfer(ws.ctx, t.id);
    // in transit: gone from the source, not yet at the destination, so available nowhere
    expect(await stock(ws, p.id, A)).toMatchObject({ onHand: 4 });
    expect(await stock(ws, p.id, B)).toMatchObject({ onHand: 0 });
    await rejects(shipTransfer(ws.ctx, t.id)); // cannot ship twice
    await rejects(cancelTransfer(ws.ctx, t.id, {})); // it has already left
    await receiveTransfer(ws.ctx, t.id);
    expect(await stock(ws, p.id, B)).toMatchObject({ onHand: 6 });
    expect(await stock(ws, p.id)).toMatchObject({ onHand: 10 });
    await rejects(receiveTransfer(ws.ctx, t.id)); // cannot receive twice
    expect(await stock(ws, p.id, B)).toMatchObject({ onHand: 6 });
    const types = (await ownerQuery('SELECT type, location_id FROM stock_movements WHERE part_id = $1 ORDER BY created_at, id', [p.id])).rows;
    expect(types.map((r) => r.type)).toEqual(['ADJUSTED', 'TRANSFER_OUT', 'TRANSFER_IN']);
    expect(types[1]!.location_id).toBe(A);
    expect(types[2]!.location_id).toBe(B);
    expect((await getTransfer(ws.ctx, t.id)).transfer).toMatchObject({ status: 'RECEIVED', from: 'Main workshop', to: 'Second workshop' });
    await expect(ownerQuery("UPDATE stock_transfers SET status = 'DRAFT' WHERE id = $1", [t.id])).rejects.toThrow();
  });

  it('cannot ship more than the source has, and a failed ship moves nothing', async () => {
    const a = await mkPart(ws, {}, 0);
    const b = await mkPart(ws, {}, 0);
    await adjustStock(ws.ctx, { partId: a.id, locationId: A, kind: 'INCREASE', quantity: 5, reasonCode: 'OPENING_BALANCE', reason: 'Seed' });
    await adjustStock(ws.ctx, { partId: b.id, locationId: A, kind: 'INCREASE', quantity: 1, reasonCode: 'OPENING_BALANCE', reason: 'Seed' });
    const t = await createTransfer(ws.ctx, { fromLocationId: A, toLocationId: B, lines: [{ partId: a.id, quantity: 5 }, { partId: b.id, quantity: 3 }], submit: true });
    await rejects(shipTransfer(ws.ctx, t.id));
    expect(await stock(ws, a.id, A)).toMatchObject({ onHand: 5 });
    expect(await stock(ws, b.id, A)).toMatchObject({ onHand: 1 });
    expect((await getTransfer(ws.ctx, t.id)).transfer.status).toBe('APPROVED');
    await cancelTransfer(ws.ctx, t.id, { reason: 'Not enough stock' });
    expect((await getTransfer(ws.ctx, t.id)).transfer.status).toBe('CANCELLED');
  });

  it('reserved stock is not shipped from under a job', async () => {
    const p = await mkPart(ws, {}, 0);
    await adjustStock(ws.ctx, { partId: p.id, locationId: A, kind: 'INCREASE', quantity: 4, reasonCode: 'OPENING_BALANCE', reason: 'Seed' });
    const { job } = await openJob(ws, { locationId: A });
    await addJobPart(ws.ctx, job.id, { inventoryItemId: p.id, quantity: 3 });
    const t = await createTransfer(ws.ctx, { fromLocationId: A, toLocationId: B, lines: [{ partId: p.id, quantity: 2 }], submit: true });
    await rejects(shipTransfer(ws.ctx, t.id));
    expect(await stock(ws, p.id, A)).toMatchObject({ onHand: 4, reserved: 3 });
  });

  it('with approval switched on, someone with the approval permission must approve before it can ship', async () => {
    const w = await invWorkspace('Transfer Approval');
    const a = await defaultLocationId(w);
    const b = await addLocation(w, 'Branch');
    await updateInventorySettings(w.ctx, { transferApprovalRequired: true });
    const p = await mkPart(w, {}, 0);
    await adjustStock(w.ctx, { partId: p.id, locationId: a, kind: 'INCREASE', quantity: 5, reasonCode: 'OPENING_BALANCE', reason: 'Seed' });
    const clerk = await memberAt(w, [a, b]); // inventory staff cannot approve
    const t = await createTransfer(clerk.ctx, { fromLocationId: a, toLocationId: b, lines: [{ partId: p.id, quantity: 2 }] });
    expect((await requestTransfer(clerk.ctx, t.id)).status).toBe('REQUESTED');
    await rejects(shipTransfer(clerk.ctx, t.id));
    await rejects(approveTransfer(clerk.ctx, t.id));
    await approveTransfer(w.ctx, t.id);
    await shipTransfer(clerk.ctx, t.id);
    expect((await getTransfer(w.ctx, t.id)).transfer.status).toBe('IN_TRANSIT');
  });

  it('shipping needs access to the source, receiving access to the destination', async () => {
    const p = await mkPart(ws, {}, 0);
    await adjustStock(ws.ctx, { partId: p.id, locationId: A, kind: 'INCREASE', quantity: 5, reasonCode: 'OPENING_BALANCE', reason: 'Seed' });
    const t = await createTransfer(ws.ctx, { fromLocationId: A, toLocationId: B, lines: [{ partId: p.id, quantity: 1 }], submit: true });
    const atA = await memberAt(ws, [A]);
    const atB = await memberAt(ws, [B]);
    await rejects(shipTransfer(atB.ctx, t.id));
    await shipTransfer(atA.ctx, t.id);
    await rejects(receiveTransfer(atA.ctx, t.id));
    await receiveTransfer(atB.ctx, t.id);
    expect(await stock(ws, p.id, B)).toMatchObject({ onHand: 1 });
    // a person with access to neither location does not even see the transfer
    const atC = await memberAt(ws, [await addLocation(ws, 'Third')]);
    await rejects(getTransfer(atC.ctx, t.id));
    expect((await listTransfers(atC.ctx, {})).items.map((x) => x.id)).not.toContain(t.id);
  });

  it('is a plan feature: a single-location plan cannot transfer', async () => {
    const w = await invWorkspace('Solo Transfers');
    await upgradePlan(w, 'solo');
    const a = await defaultLocationId(w);
    const b = await addLocation(w, 'Extra');
    const p = await mkPart(w, {}, 0);
    const e = await rejects(createTransfer(w.ctx, { fromLocationId: a, toLocationId: b, lines: [{ partId: p.id, quantity: 1 }] }));
    expect(e.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});
