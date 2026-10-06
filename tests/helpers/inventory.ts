import { randomUUID } from 'node:crypto';
import { createJob, changeJobStatus, getJobCard } from '@/server/jobcards/service';
import { createRecommendedWork, decideRecommendedWork } from '@/server/jobcards/work';
import { adjustStock } from '@/server/inventory/stock';
import { createPart } from '@/server/inventory/parts';
import { createSupplier } from '@/server/inventory/suppliers';
import { createPurchaseOrder, placePurchaseOrder } from '@/server/inventory/purchasing';
import { receiveGoods } from '@/server/inventory/receiving';
import type { JobStatus } from '@/server/jobcards/transitions';
import { createWorkspace, ownerQuery, type TestWorkspace } from './factory';
import { seedCustomerVehicle } from './workshop';

export const idem = () => `k-${randomUUID()}`;

export async function invWorkspace(name = 'Inventory Workshop'): Promise<TestWorkspace> {
  return createWorkspace(name);
}

let n = 0;

/** A catalogue part. Pass `stock` to put units on the shelf through a real opening-balance adjustment. */
export async function mkPart(ws: TestWorkspace, over: Record<string, unknown> = {}, stock = 0) {
  const i = ++n;
  const r = await createPart(ws.ctx, { sku: `SKU-${i}-${Date.now()}`, name: `Test part ${i}`, costCents: 10_000, sellPriceCents: 15_000, ...over });
  if (stock > 0) await adjustStock(ws.ctx, { partId: r.id, kind: 'INCREASE', quantity: stock, reasonCode: 'OPENING_BALANCE', reason: 'Test opening stock' });
  return { id: r.id, sku: r.sku };
}

export async function mkSupplier(ws: TestWorkspace, name = `Supplier ${++n}`, over: Record<string, unknown> = {}) {
  return createSupplier(ws.ctx, { name, email: `${name.toLowerCase().replace(/\W+/g, '')}@supplier.test`, ...over });
}

export async function defaultLocationId(ws: TestWorkspace): Promise<string> {
  return (await ownerQuery<{ id: string }>('SELECT id FROM locations WHERE business_id = $1 AND is_default', [ws.businessId])).rows[0]!.id;
}

export async function addLocation(ws: TestWorkspace, name: string): Promise<string> {
  return (await ownerQuery<{ id: string }>("INSERT INTO locations (business_id, name, status, updated_at) VALUES ($1, $2, 'ACTIVE', now()) RETURNING id", [ws.businessId, name])).rows[0]!.id;
}

/** The real counts, read straight from the database (bypassing every service). */
export async function stock(ws: TestWorkspace, partId: string, locationId?: string) {
  const r = await ownerQuery<{ on_hand: number; reserved: number }>(
    `SELECT COALESCE(sum(on_hand), 0)::int AS on_hand, COALESCE(sum(reserved), 0)::int AS reserved FROM stock_levels WHERE business_id = $1 AND part_id = $2 ${locationId ? 'AND location_id = $3' : ''}`,
    locationId ? [ws.businessId, partId, locationId] : [ws.businessId, partId],
  );
  const { on_hand, reserved } = r.rows[0]!;
  return { onHand: on_hand, reserved, available: on_hand - reserved };
}

/** The ledger rows for a part, oldest first. */
export async function ledger(ws: TestWorkspace, partId: string) {
  return (await ownerQuery<{ type: string; on_hand_delta: number; reserved_delta: number; on_hand_after: number; reserved_after: number }>(
    'SELECT type, on_hand_delta, reserved_delta, on_hand_after, reserved_after FROM stock_movements WHERE business_id = $1 AND part_id = $2 ORDER BY created_at, id', [ws.businessId, partId],
  )).rows;
}

/** An open job (checked in) for a new customer and vehicle. */
export async function openJob(ws: TestWorkspace, over: Record<string, unknown> = {}) {
  const { customer, vehicle } = await seedCustomerVehicle(ws, 'Inv');
  const { job } = await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Brakes squeal', mileageKm: 50_100, ...over });
  return { job, customer, vehicle };
}

/** Drive a job to a status with the owner's authority (the same walk the job tests use). */
export async function jobAt(ws: TestWorkspace, target: JobStatus, over: Record<string, unknown> = {}) {
  const made = await openJob(ws, over);
  const job = made.job;
  const steps: [JobStatus, (() => Promise<unknown>)?][] = [
    ['INSPECTION'], ['DIAGNOSIS'],
    ['AWAITING_APPROVAL', async () => createRecommendedWork(ws.ctx, job.id, { description: 'Replace front brake pads', priority: 'URGENT' })],
    ['APPROVED', async () => {
      const work = (await getJobCard(ws.ctx, job.id)).recommendedWork;
      for (const x of work) await decideRecommendedWork(ws.ctx, job.id, x.id, { decision: 'APPROVED', method: 'IN_PERSON' });
    }],
    ['IN_PROGRESS'], ['QUALITY_CHECK'], ['READY_FOR_COLLECTION'], ['COMPLETED'],
  ];
  for (const [s, before] of steps) {
    if ((await ownerQuery('SELECT status FROM job_cards WHERE id = $1', [job.id])).rows[0]!.status === target) break;
    if (before) await before();
    if (s === 'READY_FOR_COLLECTION') {
      await (await import('@/server/jobcards/service')).recordQualityCheck(ws.ctx, job.id, { passed: true, checklist: { work_completed: true, parts_installed: true, tools_removed: true, vehicle_inspected: true, test_drive: 'na', requested_work_completed: true } });
      continue;
    }
    await changeJobStatus(ws.ctx, job.id, { status: s });
  }
  return made;
}

/** A placed order for a supplier with the given lines (partId, quantity, unit cost). */
export async function placedOrder(ws: TestWorkspace, supplierId: string, lines: { partId: string; quantity: number; unitCostCents?: number }[], over: Record<string, unknown> = {}) {
  const po = await createPurchaseOrder(ws.ctx, { supplierId, lines: lines.map((l) => ({ partId: l.partId, quantity: l.quantity, unitCostCents: l.unitCostCents ?? 10_000 })), ...over });
  await placePurchaseOrder(ws.ctx, po.id);
  const dbLines = (await ownerQuery<{ id: string; part_id: string }>('SELECT id, part_id FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY position', [po.id])).rows;
  return { id: po.id, number: po.number, lineIds: dbLines.map((l) => l.id), lines: dbLines };
}

export async function receiveAll(ws: TestWorkspace, po: Awaited<ReturnType<typeof placedOrder>>, qty: Record<string, number>, extra: Record<string, unknown> = {}) {
  return receiveGoods(ws.ctx, po.id, { idempotencyKey: idem(), lines: po.lineIds.map((id) => ({ poLineId: id, quantityReceived: qty[id] ?? 0 })), ...extra });
}
