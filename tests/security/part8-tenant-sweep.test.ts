import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { createBooking } from '@/server/bookings/service';
import { listServiceTypes } from '@/server/workshop/service';
import { createRole } from '@/server/roles/service';
import { createSavedReport } from '@/server/reports/saved';
import { call } from '../helpers/http';
import { createMemberCtx, createWorkspace, ownerQuery, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { issuedInvoice, pay, sentQuote } from '../helpers/finance';
import { addLocation, mkPart, mkSupplier, openJob, placedOrder } from '../helpers/inventory';
import { nextWeekday, seedCustomerVehicle } from '../helpers/workshop';

afterAll(disconnectPrisma);

type Handler = (req: Request, x: { params: Promise<Record<string, string>> }) => Promise<Response>;
const NOPE = '00000000-0000-4000-8000-000000000000';
const MARK = 'ZZMARKALPHA';

let A: TestWorkspace;
let B: TestWorkspace;
const ids: Record<string, string> = {};

beforeAll(async () => {
  A = await createWorkspace(`${MARK} Motors`);
  await upgradePlan(A, 'business');
  B = await createWorkspace('Sweep Beta Motors');
  await upgradePlan(B, 'business');
  const { customer, vehicle } = await seedCustomerVehicle(A, MARK);
  ids.customer = customer.id;
  ids.vehicle = vehicle.id;
  const svc = (await listServiceTypes(A.ctx)).find((t) => t.name === 'Diagnostic')!.id;
  ids.booking = (await createBooking(A.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceTypeId: svc, date: nextWeekday(3), time: '10:00' })).id;
  const made = await openJob(A);
  ids.job = made.job.id;
  ids.quote = (await sentQuote(A, { customerId: made.customer.id, vehicleId: made.vehicle.id, jobId: made.job.id })).id;
  const inv = await issuedInvoice(A, { send: true });
  ids.invoice = inv.id;
  const paid = await pay(A, inv.id, 10_000, 'EFT');
  ids.payment = (paid as { paymentId?: string; id?: string }).paymentId ?? (paid as { id?: string }).id ?? (await ownerQuery<{ id: string }>('SELECT id FROM payments WHERE business_id = $1 LIMIT 1', [A.businessId])).rows[0]!.id;
  ids.receipt = (await ownerQuery<{ id: string }>('SELECT id FROM receipts WHERE business_id = $1 LIMIT 1', [A.businessId])).rows[0]!.id;
  const part = await mkPart(A, { name: `${MARK} part` }, 5);
  ids.part = part.id;
  const sup = await mkSupplier(A, `${MARK} Supplier`);
  ids.supplier = (sup as { id: string }).id;
  ids.po = (await placedOrder(A, ids.supplier, [{ partId: part.id, quantity: 3 }])).id;
  ids.location = await addLocation(A, `${MARK} Branch`);
  ids.member = (await createMemberCtx(A, 'technician')).ctx.membership.id;
  ids.file = (await ownerQuery<{ id: string }>('SELECT id FROM files WHERE business_id = $1 LIMIT 1', [A.businessId])).rows[0]!.id;
  ids.saved = (await createSavedReport(A.ctx, { kind: 'STANDARD', reportKey: 'invoices', name: `${MARK} report`, config: { preset: 'THIS_YEAR' } })).id;
  ids.role = (await createRole(A.ctx, { name: `${MARK} role`, permissions: ['job.view'] })).id;
  const comm = await ownerQuery<{ id: string }>('SELECT id FROM communications WHERE business_id = $1 LIMIT 1', [A.businessId]);
  ids.comm = comm.rows[0]?.id ?? NOPE;
  const note = await ownerQuery<{ id: string }>('SELECT id FROM notifications WHERE business_id = $1 LIMIT 1', [A.businessId]);
  ids.notification = note.rows[0]?.id ?? NOPE;
});

/** Which of A's real records an ID in this URL stands for. Only the first dynamic segment is real; the rest are random. */
function rootId(segments: string[]): string {
  const [first, second] = segments;
  switch (first) {
    case 'customers': return ids.customer!;
    case 'vehicles': return ids.vehicle!;
    case 'jobs': return ids.job!;
    case 'bookings': return second === 'waiting-list' || second === 'recurring' ? NOPE : ids.booking!;
    case 'quotes': return ids.quote!;
    case 'invoices': return ids.invoice!;
    case 'payments': return ids.payment!;
    case 'receipts': return ids.receipt!;
    case 'purchase-orders': return ids.po!;
    case 'inventory': return second === 'parts' ? ids.part! : second === 'suppliers' ? ids.supplier! : NOPE;
    case 'locations': return ids.location!;
    case 'members': return ids.member!;
    case 'team': return second === 'employees' ? ids.member! : NOPE;
    case 'files': return second === 'categories' ? NOPE : ids.file!;
    case 'reports': return second === 'saved' ? ids.saved! : NOPE;
    case 'role-definitions': return ids.role!;
    case 'communications': return ids.comm!;
    case 'notifications': return ids.notification!;
    default: return NOPE;
  }
}

const modules = import.meta.glob('/src/app/api/v1/**/route.ts');
const dynamicRoutes = Object.entries(modules).filter(([p]) => p.includes('['));

async function sweep(token: string) {
  const out: { route: string; method: string; status: number; text: string }[] = [];
  for (const [file, load] of dynamicRoutes) {
    const rel = file.replace('/src/app/api/v1/', '').replace('/route.ts', '').split('/');
    const keys = rel.filter((s) => s.startsWith('[')).map((s) => s.slice(1, -1));
    const params: Record<string, string> = {};
    keys.forEach((k, i) => { params[k] = i === 0 ? rootId(rel) : NOPE; });
    const mod = (await load()) as Record<string, Handler>;
    for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      if (!mod[m]) continue;
      const r = await call(mod[m]!, { method: m, token, params, body: m === 'GET' ? undefined : {} });
      out.push({ route: rel.join('/'), method: m, status: r.status, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) });
    }
  }
  return out;
}

const tables = ['customers', 'vehicles', 'bookings', 'job_cards', 'quotes', 'invoices', 'payments', 'receipts', 'parts', 'suppliers', 'purchase_orders', 'files', 'locations', 'memberships', 'roles', 'saved_reports', 'stock_movements', 'communications'];
async function fingerprint() {
  const present = (await ownerQuery<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id' AND table_name = ANY($1)", [tables])).rows.map((r) => r.table_name);
  const out: Record<string, string | null> = {};
  for (const t of present) out[t] = (await ownerQuery<{ h: string | null }>(`SELECT md5(string_agg(x::text, ',' ORDER BY x.id::text)) AS h FROM ${t} x WHERE x.business_id = $1`, [A.businessId])).rows[0]!.h;
  return out;
}

describe('every API route that takes an ID, driven with another business\'s real IDs', () => {
  it('has a meaningful number of routes to sweep, and resolves real IDs for the main records', () => {
    expect(dynamicRoutes.length).toBeGreaterThan(150);
    for (const k of ['customer', 'vehicle', 'booking', 'job', 'quote', 'invoice', 'payment', 'receipt', 'part', 'supplier', 'po', 'location', 'member', 'file', 'saved', 'role']) expect(ids[k], k).toBeTruthy();
  });

  it('Business A\'s own session reaches its records (so the sweep is not passing vacuously)', async () => {
    const a = await sweep(A.ctx.token);
    const reads = a.filter((x) => x.method === 'GET' && x.status === 200);
    expect(reads.length).toBeGreaterThan(40);
    expect(reads.some((x) => x.text.includes(MARK))).toBe(true);
  });

  it('Business B gets a refusal or nothing from every one of them, learns nothing, and changes nothing', async () => {
    const before = await fingerprint();
    expect(Object.keys(before).length).toBeGreaterThan(10);
    const b = await sweep(B.ctx.token);
    const leaks: string[] = [];
    const writesThatSucceeded: string[] = [];
    for (const x of b) {
      const foreignIds = Object.values(ids).filter((v) => v !== NOPE);
      if (x.text.includes(MARK) || foreignIds.some((id) => x.text.includes(id) && !x.text.includes('"error"'))) leaks.push(`${x.method} ${x.route} -> ${x.status}`);
      if (x.method !== 'GET' && x.status < 400) writesThatSucceeded.push(`${x.method} ${x.route} -> ${x.status}`);
      expect(x.status, `${x.method} ${x.route}`).not.toBe(500); // no crash, no internals
    }
    expect(leaks).toEqual([]);
    expect(writesThatSucceeded).toEqual([]);
    expect(await fingerprint()).toEqual(before);
    expect(b.length).toBeGreaterThan(190);
  });

  it('a request with no session reaches none of them either', async () => {
    const none = await sweep('');
    expect(none.filter((x) => x.status !== 401 && x.status !== 403 && x.status !== 404 && x.status !== 405)).toEqual([]);
    expect(none.some((x) => x.text.includes(MARK))).toBe(false);
  });
});
