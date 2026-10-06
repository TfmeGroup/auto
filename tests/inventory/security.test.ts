import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { GET as partsGET, POST as partsPOST } from '@/app/api/v1/inventory/parts/route';
import { GET as partGET, PATCH as partPATCH } from '@/app/api/v1/inventory/parts/[id]/route';
import { POST as adjustPOST } from '@/app/api/v1/inventory/stock/adjust/route';
import { GET as movementsGET } from '@/app/api/v1/inventory/movements/route';
import { GET as pricesGET } from '@/app/api/v1/inventory/parts/[id]/prices/route';
import { GET as suppliersGET, POST as suppliersPOST } from '@/app/api/v1/inventory/suppliers/route';
import { GET as supplierGET } from '@/app/api/v1/inventory/suppliers/[id]/route';
import { GET as poGET, POST as poPOST } from '@/app/api/v1/purchase-orders/route';
import { GET as poOneGET } from '@/app/api/v1/purchase-orders/[id]/route';
import { POST as poApprove } from '@/app/api/v1/purchase-orders/[id]/approve/route';
import { POST as poOrder } from '@/app/api/v1/purchase-orders/[id]/order/route';
import { POST as poReceive } from '@/app/api/v1/purchase-orders/[id]/receive/route';
import { GET as poPdf } from '@/app/api/v1/purchase-orders/[id]/pdf/route';
import { POST as transferPOST } from '@/app/api/v1/transfers/route';
import { GET as transferGET } from '@/app/api/v1/transfers/[id]/route';
import { POST as transferShip } from '@/app/api/v1/transfers/[id]/ship/route';
import { GET as employeeGET } from '@/app/api/v1/team/employees/[id]/route';
import { GET as employeesGET } from '@/app/api/v1/team/employees/route';
import { PATCH as technicianPATCH } from '@/app/api/v1/team/technicians/[id]/route';
import { POST as timeStart } from '@/app/api/v1/team/time/start/route';
import { POST as timeVoid } from '@/app/api/v1/team/time/[id]/void/route';
import { PATCH as timeEdit } from '@/app/api/v1/team/time/[id]/route';
import { GET as rateGET } from '@/app/api/v1/team/rates/route';
import { PUT as rateDefaultPUT } from '@/app/api/v1/team/rates/default/route';
import { GET as exportGET } from '@/app/api/v1/inventory/export/route';
import { GET as teamExportGET } from '@/app/api/v1/team/export/route';
import { PATCH as memberPATCH } from '@/app/api/v1/members/[id]/route';
import { GET as lookupGET } from '@/app/api/v1/inventory/parts/lookup/route';
import { PATCH as settingsPATCH } from '@/app/api/v1/inventory/settings/route';
import { call } from '../helpers/http';
import { appClient, createMemberCtx, ownerQuery, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { addLocation, defaultLocationId, idem, invWorkspace, mkPart, mkSupplier, openJob, placedOrder } from '../helpers/inventory';
import { createTransfer } from '@/server/inventory/transfers';
import { adjustStock } from '@/server/inventory/stock';
import { createManualEntry } from '@/server/team/time';
import { setTechnician } from '@/server/team/technicians';
import { memberWithPermissions } from '../helpers/workshop';
import { prisma } from '@/server/db/client';

afterAll(disconnectPrisma);

let A: TestWorkspace;
let B: TestWorkspace;
let tech: Awaited<ReturnType<typeof createMemberCtx>>;
let partA: { id: string; sku: string };
let partB: { id: string; sku: string };
let supplierA: { id: string };
let supplierB: { id: string };
let poA: Awaited<ReturnType<typeof placedOrder>>;
let poB: Awaited<ReturnType<typeof placedOrder>>;
const NOPE = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  A = await invWorkspace('Sec Shop A');
  B = await invWorkspace('Sec Shop B');
  tech = await createMemberCtx(A, 'technician');
  partA = await mkPart(A, { name: 'A part' }, 5);
  partB = await mkPart(B, { name: 'B part' }, 5);
  supplierA = await mkSupplier(A, 'Supplier A');
  supplierB = await mkSupplier(B, 'Supplier B');
  poA = await placedOrder(A, supplierA.id, [{ partId: partA.id, quantity: 4 }]);
  poB = await placedOrder(B, supplierB.id, [{ partId: partB.id, quantity: 4 }]);
});

describe('authentication and CSRF', () => {
  it('every inventory, purchasing and team endpoint needs a signed-in member', async () => {
    const id = { params: { id: NOPE } };
    const calls = [
      call(partsGET), call(partsPOST, { body: {} }), call(partGET, id), call(partPATCH, { ...id, method: 'PATCH', body: {} }), call(adjustPOST, { body: {} }), call(movementsGET), call(pricesGET, id),
      call(suppliersGET), call(suppliersPOST, { body: {} }), call(supplierGET, id), call(poGET), call(poPOST, { body: {} }), call(poOneGET, id), call(poApprove, { ...id, body: {} }), call(poReceive, { ...id, body: {} }), call(poPdf, id),
      call(transferPOST, { body: {} }), call(transferGET, id), call(employeesGET), call(employeeGET, id), call(technicianPATCH, { ...id, method: 'PATCH', body: {} }), call(timeStart, { body: {} }),
      call(rateGET), call(rateDefaultPUT, { method: 'PUT', body: {} }), call(exportGET, { query: { dataset: 'stock_list' } }), call(teamExportGET, { query: { dataset: 'directory' } }), call(lookupGET, { query: { code: 'x' } }),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(401);
  });

  it('refuses state-changing requests that come from another site', async () => {
    const r = await call(adjustPOST, { token: A.ctx.token, origin: 'https://evil.example', body: { partId: partA.id, kind: 'INCREASE', quantity: 5, reasonCode: 'OTHER', reason: 'forged request' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_REJECTED');
    expect((await ownerQuery('SELECT sum(on_hand)::int AS n FROM stock_levels WHERE part_id = $1', [partA.id])).rows[0]!.n).toBe(5);
  });
});

describe('another business\'s records are not there', () => {
  it('parts, suppliers, orders, movements, transfers, employees and time entries of business B are invisible and untouchable from A', async () => {
    const t = A.ctx.token;
    expect((await call(partGET, { token: t, params: { id: partB.id } })).status).toBe(404);
    expect((await call(partPATCH, { token: t, method: 'PATCH', params: { id: partB.id }, body: { name: 'Hijacked' } })).status).toBe(404);
    expect((await call(supplierGET, { token: t, params: { id: supplierB.id } })).status).toBe(404);
    expect((await call(poOneGET, { token: t, params: { id: poB.id } })).status).toBe(404);
    expect((await call(poPdf, { token: t, params: { id: poB.id } })).status).toBe(404);
    expect((await call(poReceive, { token: t, params: { id: poB.id }, body: { lines: [{ poLineId: poB.lineIds[0], quantityReceived: 1 }] } })).status).toBe(404);
    expect((await call(poApprove, { token: t, params: { id: poB.id }, body: {} })).status).toBe(404);
    expect((await call(employeeGET, { token: t, params: { id: B.ctx.membership.id } })).status).toBe(404);
    expect((await call(technicianPATCH, { token: t, method: 'PATCH', params: { id: B.ctx.membership.id }, body: { skills: ['x'] } })).status).toBe(404);
    // listings never include them
    const parts = await call(partsGET, { token: t, query: { pageSize: 100 } });
    expect(parts.body.data.map((p: { id: string }) => p.id)).toEqual([partA.id].concat(parts.body.data.map((p: { id: string }) => p.id).filter((i: string) => i !== partA.id && i !== partB.id)));
    expect(parts.body.data.map((p: { id: string }) => p.id)).not.toContain(partB.id);
    expect((await call(suppliersGET, { token: t })).body.data.map((s: { id: string }) => s.id)).not.toContain(supplierB.id);
    expect((await call(poGET, { token: t })).body.data.map((o: { id: string }) => o.id)).not.toContain(poB.id);
    expect((await call(movementsGET, { token: t, query: { partId: partB.id } })).body.data).toEqual([]);
    expect((await call(employeesGET, { token: t })).body.data.map((m: { id: string }) => m.id)).not.toContain(B.ctx.membership.id);
    // B's stock was never touched
    expect((await ownerQuery('SELECT sum(on_hand)::int AS n FROM stock_levels WHERE part_id = $1', [partB.id])).rows[0]!.n).toBe(5);
  });

  it('a business id, location id or user id sent in the body is ignored or refused', async () => {
    const t = A.ctx.token;
    const foreignLocation = await defaultLocationId(B);
    const r1 = await call(partsPOST, { token: t, body: { name: 'Smuggled', businessId: B.businessId, openingQuantity: 3, openingLocationId: foreignLocation } });
    expect(r1.status).toBe(422);
    const r2 = await call(partsPOST, { token: t, body: { sku: 'SMUG-1', name: 'Smuggled', businessId: B.businessId } });
    expect(r2.status).toBe(201);
    expect((await ownerQuery('SELECT business_id FROM parts WHERE id = $1', [r2.body.data.id])).rows[0]!.business_id).toBe(A.businessId);
    // adjusting stock at B's location, or on B's part, is refused
    expect((await call(adjustPOST, { token: t, body: { partId: partA.id, locationId: foreignLocation, kind: 'INCREASE', quantity: 9, reasonCode: 'OTHER', reason: 'wrong location' } })).status).toBe(422);
    expect((await call(adjustPOST, { token: t, body: { partId: partB.id, kind: 'INCREASE', quantity: 9, reasonCode: 'OTHER', reason: 'wrong business' } })).status).toBe(404);
    // an order cannot point at B's supplier or B's part
    expect((await call(poPOST, { token: t, body: { supplierId: supplierB.id, lines: [{ partId: partA.id, quantity: 1, unitCostCents: 1 }] } })).status).toBe(422);
    expect((await call(poPOST, { token: t, body: { supplierId: supplierA.id, lines: [{ partId: partB.id, quantity: 1, unitCostCents: 1 }] } })).status).toBe(422);
    // time cannot be logged on B's job
    const jobB = (await openJob(B)).job;
    expect((await call(timeStart, { token: tech.ctx.token, body: { jobId: jobB.id } })).status).toBe(404);
    // a time entry of B cannot be edited or voided by A
    const entryB = await ownerQuery<{ id: string }>("INSERT INTO time_entries (business_id, membership_id, job_id, status, source, started_at, ended_at, duration_minutes, updated_at) VALUES ($1, $2, $3, 'COMPLETED', 'MANUAL', now() - interval '2 hours', now() - interval '1 hour', 60, now()) RETURNING id", [B.businessId, B.ctx.membership.id, jobB.id]);
    expect((await call(timeVoid, { token: t, params: { id: entryB.rows[0]!.id }, body: { reason: 'cross-business void' } })).status).toBe(404);
    expect((await call(timeEdit, { token: t, method: 'PATCH', params: { id: entryB.rows[0]!.id }, body: { notes: 'x', reason: 'cross-business edit' } })).status).toBe(404);
    // nor a transfer
    const locB1 = await defaultLocationId(B);
    const locB2 = await addLocation(B, 'B annex');
    const trB = await createTransfer(B.ctx, { fromLocationId: locB1, toLocationId: locB2, lines: [{ partId: partB.id, quantity: 1 }], submit: true });
    expect((await call(transferGET, { token: t, params: { id: trB.id } })).status).toBe(404);
    expect((await call(transferShip, { token: t, params: { id: trB.id }, body: {} })).status).toBe(404);
  });
});

describe('row-level security backs it up', () => {
  it('without a business no new table shows a row, and one business cannot read or write another\'s', async () => {
    const c = await appClient();
    try {
      for (const table of ['parts', 'suppliers', 'stock_levels', 'stock_movements', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'stock_transfers', 'time_entries', 'technician_profiles', 'inventory_settings', 'part_categories', 'job_assignment_events']) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [A.businessId]);
      expect((await c.query('SELECT count(*)::int AS n FROM parts WHERE id = $1', [partB.id])).rows[0].n).toBe(0);
      expect((await c.query('SELECT count(*)::int AS n FROM parts WHERE id = $1', [partA.id])).rows[0].n).toBe(1);
      await expect(c.query('INSERT INTO suppliers (business_id, name, updated_at) VALUES ($1, $2, now())', [B.businessId, 'Forged'])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});

describe('permissions are enforced on the server', () => {
  it('a technician cannot adjust stock, see costs, manage suppliers, approve or place orders, receive, or export', async () => {
    const t = tech.ctx.token;
    expect((await call(adjustPOST, { token: t, body: { partId: partA.id, kind: 'INCREASE', quantity: 50, reasonCode: 'OTHER', reason: 'free parts' } })).status).toBe(403);
    expect((await call(pricesGET, { token: t, params: { id: partA.id } })).status).toBe(403);
    const view = await call(partGET, { token: t, params: { id: partA.id } });
    expect(view.status).toBe(200);
    expect(view.body.data.part.costCents).toBeNull();
    expect(view.body.data.canSeeCosts).toBe(false);
    expect((await call(suppliersPOST, { token: t, body: { name: 'Mine now' } })).status).toBe(403);
    expect((await call(partsPOST, { token: t, body: { name: 'New part' } })).status).toBe(403);
    expect((await call(partPATCH, { token: t, method: 'PATCH', params: { id: partA.id }, body: { sellPriceCents: 1 } })).status).toBe(403);
    expect((await call(poPOST, { token: t, body: { supplierId: supplierA.id, lines: [{ partId: partA.id, quantity: 1, unitCostCents: 1 }] } })).status).toBe(403);
    expect((await call(poApprove, { token: t, params: { id: poA.id }, body: {} })).status).toBe(403);
    expect((await call(poOrder, { token: t, params: { id: poA.id }, body: {} })).status).toBe(403);
    expect((await call(poReceive, { token: t, params: { id: poA.id }, body: { lines: [{ poLineId: poA.lineIds[0], quantityReceived: 1 }] } })).status).toBe(403);
    expect((await call(poPdf, { token: t, params: { id: poA.id } })).status).toBe(403);
    expect((await call(exportGET, { token: t, query: { dataset: 'stock_list' } })).status).toBe(403);
    expect((await call(settingsPATCH, { token: t, method: 'PATCH', body: { allowNegativeStock: true } })).status).toBe(403);
    expect((await call(employeesGET, { token: t })).status).toBe(403);
    expect((await call(rateGET, { token: t })).status).toBe(403);
    expect((await call(rateDefaultPUT, { token: t, method: 'PUT', body: { rateCentsPerHour: 1 } })).status).toBe(403);
    expect((await call(teamExportGET, { token: t, query: { dataset: 'directory' } })).status).toBe(403);
    expect((await ownerQuery('SELECT sum(on_hand)::int AS n FROM stock_levels WHERE part_id = $1', [partA.id])).rows[0]!.n).toBe(5);
    // purchase-order prices are not visible to a person who may only view stock
    const po = await call(poOneGET, { token: t, params: { id: poA.id } });
    expect(po.status).toBe(200);
    expect(po.body.data.order.totalCents).toBeNull();
    expect(JSON.stringify(po.body.data)).not.toMatch(/"unitCostCents":\d/);
  });

  it('role changes, technician settings and time edits need their own permissions', async () => {
    const t = tech.ctx.token;
    const other = await createMemberCtx(A, 'technician');
    const adminRole = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'admin' } });
    expect((await call(memberPATCH, { token: t, method: 'PATCH', params: { id: other.ctx.membership.id }, body: { roleId: adminRole.id } })).status).toBe(403);
    expect((await call(technicianPATCH, { token: t, method: 'PATCH', params: { id: other.ctx.membership.id }, body: { skills: ['x'] } })).status).toBe(403);
    expect((await call(employeeGET, { token: t, params: { id: other.ctx.membership.id } })).status).toBe(403);
    const { job } = await openJob(A, { primaryTechnicianMembershipId: tech.ctx.membership.id });
    await ownerQuery("UPDATE job_cards SET opened_at = now() - interval '2 days' WHERE id = $1", [job.id]);
    const e = await createManualEntry(tech.ctx, { jobId: job.id, startedAt: new Date(Date.now() - 3 * 3_600_000), endedAt: new Date(Date.now() - 2 * 3_600_000) });
    expect((await call(timeEdit, { token: t, method: 'PATCH', params: { id: e.id }, body: { notes: 'padded', reason: 'my hours' } })).status).toBe(403);
    expect((await call(timeVoid, { token: t, params: { id: e.id }, body: { reason: 'hide it' } })).status).toBe(403);
    const manager = await createMemberCtx(A, 'manager');
    const adminAttempt = await call(memberPATCH, { token: manager.ctx.token, method: 'PATCH', params: { id: other.ctx.membership.id }, body: { roleId: adminRole.id } });
    expect(adminAttempt.status).toBe(403); // a manager may not grant a role with more access than their own
    void setTechnician;
  });

  it('negative stock can only be allowed by someone with that permission, and manual adjustments below zero need it too', async () => {
    const w = await invWorkspace('Negative Permission');
    const staff = await memberWithPermissions(w, ['inventory.view', 'inventory.adjust', 'inventory.manage_settings']);
    const e = await call(settingsPATCH, { token: staff.ctx.token, method: 'PATCH', body: { allowNegativeStock: true } });
    expect(e.status).toBe(403);
    await call(settingsPATCH, { token: w.ctx.token, method: 'PATCH', body: { allowNegativeStock: true } });
    const p = await mkPart(w, {}, 1);
    const r = await call(adjustPOST, { token: staff.ctx.token, body: { partId: p.id, kind: 'DECREASE', quantity: 3, reasonCode: 'MISSING', reason: 'Gone missing', idempotencyKey: idem() } });
    expect(r.status).toBe(409); // adjusting below zero needs the negative-stock permission as well
    await adjustStock(w.ctx, { partId: p.id, kind: 'DECREASE', quantity: 3, reasonCode: 'MISSING', reason: 'Owner may go below zero' });
    expect((await ownerQuery('SELECT sum(on_hand)::int AS n FROM stock_levels WHERE part_id = $1', [p.id])).rows[0]!.n).toBe(-2);
  });
});

describe('plan entitlements are enforced by the endpoints, not the screens', () => {
  it('purchase orders, transfers, time tracking, imports and advanced reports answer 402 on a plan without them', async () => {
    const w = await invWorkspace('Solo Plan');
    await upgradePlan(w, 'solo');
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const t = w.ctx.token;
    expect((await call(poPOST, { token: t, body: { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 1 }] } })).status).toBe(402);
    expect((await call(poGET, { token: t })).status).toBe(200); // looking is fine
    expect((await call(transferPOST, { token: t, body: { fromLocationId: NOPE, toLocationId: NOPE, lines: [] } })).status).toBe(402);
    expect((await call(timeStart, { token: t, body: { jobId: NOPE } })).status).toBe(402);
    expect((await call(lookupGET, { token: t, query: { code: 'x' } })).status).toBe(402);
    // the catalogue itself is on every plan
    expect((await call(partsPOST, { token: t, body: { name: 'Basic part' } })).status).toBe(201);
    expect((await call(suppliersPOST, { token: t, body: { name: 'Basic supplier' } })).status).toBe(201);
  });
});
