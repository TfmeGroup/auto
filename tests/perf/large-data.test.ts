import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { disconnectPrisma } from '@/server/db/client';
import { listCustomers } from '@/server/customers/service';
import { listVehicles } from '@/server/vehicles/service';
import { listJobs } from '@/server/jobcards/service';
import { listInvoices } from '@/server/finance/invoices';
import { listPayments, listReceipts } from '@/server/finance/payments';
import { listParts } from '@/server/inventory/parts';
import { listFiles } from '@/server/files/service';
import { listCommunications } from '@/server/notifications/history';
import { listNotifications } from '@/server/notifications/inapp';
import { getDashboard } from '@/server/dashboard/service';
import { globalSearch } from '@/server/search/service';
import { runReport } from '@/server/reports/run';
import { createJob } from '@/server/jobcards/service';
import { getInvoice } from '@/server/finance/invoices';
import { upgradePlan, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { issuedInvoice, pay } from '../helpers/finance';
import { mkPart } from '../helpers/inventory';
import { seedCustomerVehicle } from '../helpers/workshop';

/**
 * Thousands of records, through the real services. The data is made by bulk-cloning real, valid template records (so every constraint,
 * trigger and policy applies to them exactly as it would to real rows) and is removed again at the end, so the rest of the suite and the
 * integrity audit are unaffected. Timings are written to the test output; the assertions are deliberately generous (a slow CI machine must
 * not fail them) but would catch an accidental full-table scan or an unpaginated query on this data.
 */
afterAll(async () => {
  await cleanup();
  await disconnectPrisma();
});

const N = { customers: 10_000, jobs: 5_000, invoices: 5_000, parts: 5_000, files: 5_000, comms: 5_000, notifications: 5_000 };
let ws: TestWorkspace;
const timings: Record<string, number> = {};
const tpl: Record<string, string> = {};

const owner = () => new pg.Client({ connectionString: process.env.TEST_OWNER_DATABASE_URL });

async function cols(table: string): Promise<string[]> {
  return (await ownerQuery<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position", [table])).rows.map((r) => r.column_name);
}
/** Insert `count` copies of the template rows matched by `where`, overriding the columns that must differ (g = the copy number). */
async function clone(table: string, count: number, where: string, over: Record<string, string>, params: unknown[] = [], opts: { triggersOff?: boolean } = {}) {
  const c = await cols(table);
  const sel = c.map((x) => over[x] ?? `t.${x}`).join(', ');
  const sql = `INSERT INTO ${table} (${c.join(', ')}) SELECT ${sel} FROM (SELECT * FROM ${table} WHERE ${where}) t CROSS JOIN generate_series(1, ${count}) g`;
  if (!opts.triggersOff) return void (await ownerQuery(sql, params));
  // Issued invoices refuse new lines (by design). The seed is copying already-valid, already-issued invoices, so this one statement runs with triggers off.
  const client = owner();
  await client.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}
const uid = (prefix: string) => `md5('${prefix}-' || g)::uuid`;

async function cleanup() {
  if (!ws) return;
  const tables = (await ownerQuery<{ table_name: string }>("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE')")).rows.map((r) => r.table_name);
  const client = owner();
  await client.connect();
  try {
    await client.query('SET session_replication_role = replica'); // the rows are being retired wholesale: skip per-row triggers and ordering of foreign keys
    for (const t of tables) await client.query(`DELETE FROM "${t}" WHERE business_id = $1`, [ws.businessId]);
    await client.query('DELETE FROM businesses WHERE id = $1', [ws.businessId]);
  } finally {
    await client.end();
  }
}

async function timed<T>(label: string, fn: () => Promise<T>, maxMs: number): Promise<T> {
  await fn(); // warm the plan cache and the connection
  const t0 = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t0);
  timings[label] = ms;
  expect(ms, `${label} took ${ms} ms`).toBeLessThan(maxMs);
  return r;
}

beforeAll(async () => {
  ws = await createWorkspace('Perf Motors (large data)');
  await upgradePlan(ws, 'business');
  const { customer, vehicle } = await seedCustomerVehicle(ws, 'Tpl');
  tpl.customer = customer.id;
  tpl.vehicle = vehicle.id;
  tpl.job = (await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Template job', mileageKm: 50_100 })).job.id;
  const inv = await issuedInvoice(ws, { customerId: customer.id, vehicleId: vehicle.id, send: true });
  tpl.invoice = inv.id;
  await pay(ws, inv.id, (await getInvoice(ws.ctx, inv.id)).invoice.totalCents, 'EFT');
  tpl.part = (await mkPart(ws, { name: 'Template part' }, 0)).id;
  const B = ws.businessId;

  await clone('customers', N.customers, 'id = $1', {
    id: uid('perf-c'), customer_number: `'PC' || lpad(g::text, 7, '0')`, name: `'Perf Customer ' || g`, first_name: `'Perf'`, last_name: `'Customer' || g`,
    email: `'perf' || g || '@example.test'`, mobile: `'082' || lpad(g::text, 7, '0')`, company_name: 'NULL', alt_phone: 'NULL',
  }, [tpl.customer]);
  await clone('vehicles', N.customers, 'id = $1', {
    id: uid('perf-v'), customer_id: uid('perf-c'), registration: `'PF' || lpad(g::text, 5, '0') || ' GP'`, registration_norm: `'PF' || lpad(g::text, 5, '0') || 'GP'`, vin: 'NULL',
  }, [tpl.vehicle]);
  await clone('job_cards', N.jobs, 'id = $1', {
    id: uid('perf-j'), job_number: `'PJ-' || lpad(g::text, 7, '0')`, customer_id: uid('perf-c'), vehicle_id: uid('perf-v'), booking_id: 'NULL',
    opened_at: `now() - (g || ' minutes')::interval`,
  }, [tpl.job]);
  await clone('invoices', N.invoices, 'id = $1', {
    id: uid('perf-i'), number: `'PI-' || lpad(g::text, 7, '0')`, customer_id: uid('perf-c'), vehicle_id: uid('perf-v'), job_id: 'NULL', quote_id: 'NULL', pdf_file_id: 'NULL',
    invoice_date: `current_date - (g % 120)`, due_date: `current_date - (g % 120) + 14`,
  }, [tpl.invoice]);
  await clone('invoice_lines', N.invoices, 'invoice_id = $1', { id: 'gen_random_uuid()', invoice_id: uid('perf-i'), job_part_id: 'NULL', job_labour_id: 'NULL', inventory_item_id: 'NULL' }, [tpl.invoice], { triggersOff: true });
  await clone('payments', N.invoices, 'invoice_id = $1', {
    id: uid('perf-p'), number: `'PP-' || lpad(g::text, 7, '0')`, invoice_id: uid('perf-i'), customer_id: uid('perf-c'), vehicle_id: uid('perf-v'), job_id: 'NULL', quote_id: 'NULL', idempotency_key: 'NULL',
    paid_at: `now() - (g || ' hours')::interval`,
  }, [tpl.invoice]);
  await clone('receipts', N.invoices, 'invoice_id = $1', {
    id: uid('perf-r'), number: `'PR-' || lpad(g::text, 7, '0')`, payment_id: uid('perf-p'), invoice_id: uid('perf-i'), customer_id: uid('perf-c'), file_id: 'NULL',
  }, [tpl.invoice]);
  await clone('parts', N.parts, 'id = $1', { id: uid('perf-part'), sku: `'PSKU-' || g`, name: `'Perf part ' || g`, barcode: 'NULL', supplier_id: 'NULL', category_id: 'NULL' }, [tpl.part]);

  const f = await ownerQuery<{ id: string }>("SELECT id FROM files WHERE business_id = $1 AND status = 'ACTIVE' LIMIT 1", [B]);
  if (f.rows[0]) await clone('files', N.files, 'id = $1', { id: uid('perf-f'), storage_key: `'perf/' || g`, version_group_id: 'gen_random_uuid()', resource_id: `md5(g::text)`, name: `'perf-document-' || g || '.pdf'`, original_name: `'perf-document-' || g || '.pdf'`, checksum: `md5(g::text)` }, [f.rows[0].id]).catch((e) => { timings['files-seed-skipped'] = 1; console.warn('files seed skipped:', String(e).slice(0, 200)); });
  const c = await ownerQuery<{ id: string }>('SELECT id FROM communications WHERE business_id = $1 LIMIT 1', [B]);
  if (c.rows[0]) await clone('communications', N.comms, 'id = $1', { id: 'gen_random_uuid()', dedupe_key: `'perf-' || g` }, [c.rows[0].id]).catch((e) => { timings['comms-seed-skipped'] = 1; console.warn('communications seed skipped:', String(e).slice(0, 200)); });
  const n = await ownerQuery<{ id: string }>('SELECT id FROM notifications WHERE business_id = $1 LIMIT 1', [B]);
  if (n.rows[0]) await clone('notifications', N.notifications, 'id = $1', { id: 'gen_random_uuid()', group_key: 'NULL', dedupe_key: `'perf-' || g` }, [n.rows[0].id]).catch((e) => { timings['notifications-seed-skipped'] = 1; console.warn('notifications seed skipped:', String(e).slice(0, 200)); });
  await ownerQuery('ANALYZE');
}, 600_000);

describe('thousands of records: lists are paginated, searches are indexed, reports stay bounded', () => {
  it('the data really is there', async () => {
    const c = (await ownerQuery<Record<string, number>>(
      `SELECT (SELECT count(*) FROM customers WHERE business_id = $1)::int AS customers, (SELECT count(*) FROM vehicles WHERE business_id = $1)::int AS vehicles,
              (SELECT count(*) FROM job_cards WHERE business_id = $1)::int AS jobs, (SELECT count(*) FROM invoices WHERE business_id = $1)::int AS invoices,
              (SELECT count(*) FROM payments WHERE business_id = $1)::int AS payments, (SELECT count(*) FROM parts WHERE business_id = $1)::int AS parts`, [ws.businessId])).rows[0]!;
    expect(c.customers).toBeGreaterThan(9_000);
    expect(c.vehicles).toBeGreaterThan(9_000);
    expect(c.jobs).toBeGreaterThan(4_000);
    expect(c.invoices).toBeGreaterThan(4_000);
    expect(c.payments).toBeGreaterThan(4_000);
    expect(c.parts).toBeGreaterThan(4_000);
  });

  it('customer list and search return one bounded page, quickly, with the true total', async () => {
    const page = await timed('customers page 1', () => listCustomers(ws.ctx, { page: 1, pageSize: 25 }), 2500);
    expect(page.items.length).toBe(25);
    expect(page.meta.total).toBeGreaterThan(9_000);
    const huge = await listCustomers(ws.ctx, { page: 1, pageSize: 100_000 }).catch((e) => e);
    expect(huge.items?.length ?? 0).toBeLessThanOrEqual(100); // the page size is capped, never "everything"
    const found = await timed('customers search by name', () => listCustomers(ws.ctx, { q: 'Customer7777', page: 1, pageSize: 25 }), 2500);
    expect(found.items.some((c: { name: string }) => c.name.includes('7777'))).toBe(true);
    const byPhone = await timed('customers search by phone digits', () => listCustomers(ws.ctx, { q: '0820004242', page: 1, pageSize: 25 }), 2500);
    expect(byPhone.items.length).toBeGreaterThanOrEqual(1);
    await timed('customers deep page', () => listCustomers(ws.ctx, { page: 300, pageSize: 25 }), 3000);
  });

  it('vehicle, job, invoice, payment, receipt and part lists and searches stay fast and bounded', async () => {
    expect((await timed('vehicles page 1', () => listVehicles(ws.ctx, { page: 1, pageSize: 25 }), 2500)).items.length).toBe(25);
    expect((await timed('vehicles search by registration', () => listVehicles(ws.ctx, { q: 'PF04242', page: 1, pageSize: 25 }), 2500)).items.length).toBeGreaterThanOrEqual(1);
    expect((await timed('jobs page 1', () => listJobs(ws.ctx, { page: 1, pageSize: 25 }), 2500)).items.length).toBe(25);
    expect((await timed('jobs search by number', () => listJobs(ws.ctx, { q: 'PJ-0004242', page: 1, pageSize: 25 }), 2500)).items.length).toBeGreaterThanOrEqual(1);
    expect((await timed('invoices page 1', () => listInvoices(ws.ctx, { page: 1, pageSize: 25 }), 2500)).items.length).toBe(25);
    expect((await timed('invoices search by number', () => listInvoices(ws.ctx, { q: 'PI-0004242', page: 1, pageSize: 25 }), 2500)).items.length).toBeGreaterThanOrEqual(1);
    expect((await timed('payments page 1', () => listPayments(ws.ctx, { page: 1, pageSize: 25 }), 2500)).items.length).toBe(25);
    expect((await timed('receipts page 1', () => listReceipts(ws.ctx, { page: 1, pageSize: 25 }), 2500)).items.length).toBe(25);
    expect((await timed('parts page 1', () => listParts(ws.ctx, { page: 1, pageSize: 25 }), 2500)).items.length).toBe(25);
    expect((await timed('parts search by name', () => listParts(ws.ctx, { q: 'Perf part 4242', page: 1, pageSize: 25 }), 2500)).items.length).toBeGreaterThanOrEqual(1);
  });

  it('documents, messages and notifications are paginated too', async () => {
    const f = await timed('files page 1', () => listFiles(ws.ctx, { page: 1, pageSize: 25 }), 2500);
    expect(f.items.length).toBeLessThanOrEqual(25);
    expect(f.items.length).toBeGreaterThan(0);
    const c = await timed('communications page 1', () => listCommunications(ws.ctx, { page: 1, pageSize: 25 }), 2500);
    expect(c.items.length).toBeLessThanOrEqual(25);
    const n = await timed('notifications page 1', () => listNotifications(ws.ctx, { page: 1, pageSize: 25 }), 2500);
    expect(n.items.length).toBeLessThanOrEqual(25);
  });

  it('global search, the dashboard and the reports stay responsive on this data', async () => {
    await timed('global search', () => globalSearch(ws.ctx, { q: 'Customer4242', limit: 5 }), 3000);
    await timed('dashboard', () => getDashboard(ws.ctx), 4000);
    const rev = await timed('report: revenue', () => runReport(ws.ctx, 'revenue', { preset: 'THIS_YEAR' }), 6000);
    expect(rev.summary!.find((m) => m.key === 'invoiced')!.value as number).toBeGreaterThan(0);
    await timed('report: invoices (paged)', () => runReport(ws.ctx, 'invoices', { preset: 'THIS_YEAR', page: 1, pageSize: 50 }), 6000);
    await timed('report: receivables', () => runReport(ws.ctx, 'receivables', {}), 6000);
    await timed('report: payments', () => runReport(ws.ctx, 'payments', { preset: 'THIS_YEAR' }), 6000);
    await timed('report: jobs', () => runReport(ws.ctx, 'jobs', { preset: 'THIS_YEAR' }), 6000);
    await timed('report: customers', () => runReport(ws.ctx, 'customers', { page: 1, pageSize: 50 }), 6000);
    await timed('report: stock', () => runReport(ws.ctx, 'stock', { page: 1, pageSize: 50 }), 6000);
  });

  it('every searched column has a valid trigram index, so ILIKE search never needs a full scan on a large tenant', async () => {
    const rows = await ownerQuery<{ indexname: string }>("SELECT i.indexname FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname JOIN pg_index x ON x.indexrelid = c.oid WHERE i.schemaname = 'public' AND i.indexdef ILIKE '%gin_trgm_ops%' AND x.indisvalid");
    const have = new Set(rows.rows.map((r) => r.indexname));
    // The columns people actually search: customers, vehicles, jobs, quotes, invoices, payments, receipts, credit notes, parts, suppliers, purchase orders, documents.
    for (const idx of ['customers_name_trgm', 'customers_email_trgm', 'customers_number_trgm', 'vehicles_reg_trgm', 'vehicles_vin_trgm', 'job_cards_number_trgm', 'quotes_number_trgm', 'invoices_number_trgm',
      'payments_number_trgm', 'receipts_number_trgm', 'credit_notes_number_trgm', 'parts_name_trgm', 'parts_sku_trgm', 'parts_barcode_trgm', 'suppliers_name_trgm', 'purchase_orders_number_trgm', 'files_name_trgm']) {
      expect(have.has(idx), idx).toBe(true);
    }
  });

  it('no list issues more SQL statements for a bigger page (no N+1): 5 rows and 50 rows cost the same number of queries', async () => {
    let count = 0;
    const original = pg.Client.prototype.query;
    // Count every statement the database driver is asked to run while a list is being built.
    (pg.Client.prototype as { query: unknown }).query = function patched(this: unknown, ...args: unknown[]) {
      count++;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    const lists: Record<string, (pageSize: number) => Promise<{ items: unknown[] }>> = {
      customers: (n) => listCustomers(ws.ctx, { page: 1, pageSize: n }),
      vehicles: (n) => listVehicles(ws.ctx, { page: 1, pageSize: n }),
      jobs: (n) => listJobs(ws.ctx, { page: 1, pageSize: n }),
      invoices: (n) => listInvoices(ws.ctx, { page: 1, pageSize: n }),
      payments: (n) => listPayments(ws.ctx, { page: 1, pageSize: n }),
      receipts: (n) => listReceipts(ws.ctx, { page: 1, pageSize: n }),
      parts: (n) => listParts(ws.ctx, { page: 1, pageSize: n }),
      files: (n) => listFiles(ws.ctx, { page: 1, pageSize: n }),
      communications: (n) => listCommunications(ws.ctx, { page: 1, pageSize: n }),
      notifications: (n) => listNotifications(ws.ctx, { page: 1, pageSize: n }),
    };
    const counts: Record<string, [number, number]> = {};
    try {
      for (const [name, run] of Object.entries(lists)) {
        await run(5); // warm
        count = 0;
        const small = await run(5);
        const smallCount = count;
        count = 0;
        const big = await run(50);
        counts[name] = [smallCount, count];
        if (big.items.length > small.items.length) expect(count, `${name}: ${smallCount} queries for 5 rows but ${count} for ${big.items.length}`).toBeLessThanOrEqual(smallCount + 1);
      }
    } finally {
      (pg.Client.prototype as { query: unknown }).query = original;
    }
    process.stderr.write(`QUERY COUNTS (5 rows / 50 rows): ${JSON.stringify(counts)}\n`);
  });

  it('reports the timings (informational)', () => {
    process.stderr.write(`LARGE-DATA TIMINGS (ms, warm): ${JSON.stringify(timings)}\n`);
  });
});
