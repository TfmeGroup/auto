import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { createInvoice, finaliseInvoice } from '@/server/finance/invoices';
import { SOURCES, schemaFor } from '@/server/reports/custom/schema';
import { archiveSavedReport, createSavedReport, listSavedReports, runPreview, runSavedReport, updateSavedReport } from '@/server/reports/saved';
import { createMemberCtx, createWorkspace, upgradePlan, ownerQuery, businessContext, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, pay } from '../helpers/finance';
import { openJob } from '../helpers/inventory';
import { memberWithPermissions } from '../helpers/workshop';

afterAll(disconnectPrisma);

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

let ws: TestWorkspace;
const preview = (ctx: TestWorkspace['ctx'], config: Record<string, unknown>) => runPreview(ctx, { name: 'T', config });

beforeAll(async () => {
  ws = await financeWorkspace('Custom Reports Workshop');
  await upgradePlan(ws, 'business');
  for (let i = 0; i < 3; i++) {
    const { job, customer, vehicle } = await openJob(ws);
    const d = await createInvoice(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, jobId: job.id, lines: [L('Part', 1, 100_000 * (i + 1), { unitCostCents: 40_000 })] });
    await finaliseInvoice(ws.ctx, d.id);
    if (i === 0) await pay(ws, d.id, 50_000, 'CASH');
  }
});

describe('the approved reporting schema', () => {
  it('never exposes credentials, tokens, contact details or private data', () => {
    const banned = /password|token|secret|hash|session|mfa|email|mobile|phone|id_number|idnumber|api_key|credential|ip_address/i;
    for (const s of SOURCES) {
      expect(s.key).not.toMatch(/user|session|auth|audit|credential|webhook|communication/);
      for (const f of s.fields) {
        expect(f.key + f.label).not.toMatch(banned);
        expect(f.sql({ today: '2026-01-01', tz: 'UTC', bid: 'x', scope: null }).text).not.toMatch(banned);
      }
    }
  });

  it('only offers a person the sources and fields their permissions allow', () => {
    const has = (p: string) => ['report.view', 'job.view'].includes(p);
    const schema = schemaFor(has as never, new Set());
    expect(schema.map((s) => s.key)).toEqual(['jobs']);
    expect(schema[0]!.fields.map((f) => f.key)).not.toContain('invoiced');
  });
});

describe('running a custom report', () => {
  it('lists chosen fields with filters and sorting', async () => {
    const r = await preview(ws.ctx, { source: 'invoices', fields: ['number', 'customer', 'total', 'outstanding', 'status'], filters: [{ field: 'status', op: 'eq', value: 'UNPAID' }], sort: [{ column: 'total', dir: 'desc' }] });
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => x.c2)).toEqual([300_000, 200_000]);
    expect(r.columns.map((c) => c.label)).toEqual(['Invoice number', 'Customer', 'Total (incl. VAT)', 'Outstanding', 'Status']);
  });

  it('groups and totals: invoiced and outstanding by status', async () => {
    const r = await preview(ws.ctx, {
      source: 'invoices', groupBy: [{ field: 'status' }], metrics: [{ fn: 'count' }, { fn: 'sum', field: 'total' }, { fn: 'sum', field: 'outstanding' }], sort: [{ column: 'metric:1', dir: 'desc' }],
    });
    const byStatus = Object.fromEntries(r.rows.map((x) => [x.c0, { n: x.c1, total: x.c2, out: x.c3 }]));
    expect(byStatus['Unpaid']).toEqual({ n: 2, total: 500_000, out: 500_000 });
    expect(byStatus['Partially paid']).toEqual({ n: 1, total: 100_000, out: 50_000 });
  });

  it('a total with no grouping gives one row; dates can be grouped by month', async () => {
    const one = await preview(ws.ctx, { source: 'invoices', metrics: [{ fn: 'sum', field: 'total' }, { fn: 'avg', field: 'total' }, { fn: 'max', field: 'total' }] });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ c0: 600_000, c1: 200_000, c2: 300_000 });
    const m = await preview(ws.ctx, { source: 'invoices', groupBy: [{ field: 'invoiceDate', grain: 'month' }], metrics: [{ fn: 'count' }] });
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]!.c1).toBe(3);
  });

  it('applies a date range and ignores rows outside it', async () => {
    const r = await preview(ws.ctx, { source: 'invoices', fields: ['number'], dateRange: { preset: 'CUSTOM', from: '2020-01-01', to: '2020-12-31' } });
    expect(r.total).toBe(0);
  });

  it('refuses a field, source, operator or value outside the approved schema', async () => {
    expect((await err(preview(ws.ctx, { source: 'users', fields: ['email'] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', fields: ['password_hash'] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', fields: ['number; DROP TABLE invoices'] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', fields: ['total'], filters: [{ field: 'total', op: 'contains', value: 'x' }] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', fields: ['status'], filters: [{ field: 'status', op: 'eq', value: 'NOT_A_STATUS' }] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', fields: ['total'], filters: [{ field: 'total', op: 'gt', value: 'abc' }] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', fields: ['number'], metrics: [{ fn: 'count' }] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', groupBy: [{ field: 'number' }, { field: 'status' }, { field: 'customer' }] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', metrics: [{ fn: 'sum', field: 'customer' }] }))).status).toBe(422);
    expect((await err(preview(ws.ctx, { source: 'invoices', fields: ['number'], sort: [{ column: 'total (select 1)' }] }))).status).toBe(422);
  });

  it('text from the browser is only ever a value: a hostile string matches nothing and breaks nothing', async () => {
    const r = await preview(ws.ctx, { source: 'invoices', fields: ['number'], filters: [{ field: 'customer', op: 'contains', value: "'; DROP TABLE invoices; --" }] });
    expect(r.total).toBe(0);
    const still = await preview(ws.ctx, { source: 'invoices', fields: ['number'] });
    expect(still.total).toBe(3);
    const wild = await preview(ws.ctx, { source: 'invoices', fields: ['number'], filters: [{ field: 'customer', op: 'contains', value: '%' }] });
    expect(wild.total).toBe(0); // % is literal, not "match everything"
  });
});

describe('custom report security', () => {
  it('a person cannot build a report that reads data their permissions do not cover', async () => {
    const m = await memberWithPermissions(ws, ['report.view', 'report.create_custom', 'job.view']);
    // finance field on jobs
    const e = await err(preview(m.ctx, { source: 'jobs', fields: ['jobNumber', 'invoiced'] }));
    expect(e.status).toBe(403);
    expect(e.message).toMatch(/Invoiced/);
    // filtering on a hidden field would leak it
    expect((await err(preview(m.ctx, { source: 'jobs', fields: ['jobNumber'], filters: [{ field: 'invoiced', op: 'gt', value: 1 }] }))).status).toBe(403);
    // grouping or summing it too
    expect((await err(preview(m.ctx, { source: 'jobs', metrics: [{ fn: 'sum', field: 'invoiced' }] }))).status).toBe(403);
    // a whole source they cannot see
    expect((await err(preview(m.ctx, { source: 'invoices', fields: ['number'] }))).status).toBe(403);
    expect((await err(preview(m.ctx, { source: 'employees', fields: ['name'] }))).status).toBe(403);
    // what they CAN see works
    expect((await preview(m.ctx, { source: 'jobs', fields: ['jobNumber', 'status'] })).total).toBe(3);
  });

  it('cost fields need cost permission', async () => {
    const m = await memberWithPermissions(ws, ['report.view', 'report.create_custom', 'inventory.view']);
    expect((await err(preview(m.ctx, { source: 'parts', fields: ['sku', 'cost'] }))).status).toBe(403);
    expect((await err(preview(m.ctx, { source: 'parts', fields: ['sku', 'stockValue'] }))).status).toBe(403);
    expect((await preview(m.ctx, { source: 'parts', fields: ['sku', 'onHand'] })).columns).toHaveLength(2);
  });

  it('building reports needs the permission and the plan', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(preview(tech.ctx, { source: 'jobs', fields: ['jobNumber'] }))).status).toBe(403);
    const viewer = await memberWithPermissions(ws, ['report.view', 'job.view']);
    expect((await err(preview(viewer.ctx, { source: 'jobs', fields: ['jobNumber'] }))).status).toBe(403); // report.view is not report.create_custom
    const team = await createWorkspace('Custom Team');
    await upgradePlan(team, 'team');
    expect((await err(preview(team.ctx, { source: 'jobs', fields: ['jobNumber'] }))).status).toBe(402);
  });

  it('never returns another business\'s rows', async () => {
    const other = await financeWorkspace('Custom Other');
    await upgradePlan(other, 'business');
    expect((await preview(other.ctx, { source: 'invoices', fields: ['number'] })).total).toBe(0);
    expect((await preview(other.ctx, { source: 'jobs', fields: ['jobNumber'] })).total).toBe(0);
    expect((await preview(other.ctx, { source: 'customers', fields: ['name'] })).total).toBe(0);
  });

  it('a restricted member sees only their locations', async () => {
    const ws2 = await financeWorkspace('Custom Locations');
    await upgradePlan(ws2, 'business');
    const second = (await ownerQuery<{ id: string }>("INSERT INTO locations (business_id, name, status, updated_at) VALUES ($1, 'Branch', 'ACTIVE', now()) RETURNING id", [ws2.businessId])).rows[0]!.id;
    const main = (await ownerQuery<{ id: string }>('SELECT id FROM locations WHERE business_id = $1 AND is_default', [ws2.businessId])).rows[0]!.id;
    const a = await openJob(ws2); const b = await openJob(ws2);
    await ownerQuery('UPDATE job_cards SET location_id = $2 WHERE id = $1', [a.job.id, main]);
    await ownerQuery('UPDATE job_cards SET location_id = $2 WHERE id = $1', [b.job.id, second]);
    expect((await preview(ws2.ctx, { source: 'jobs', fields: ['jobNumber'] })).total).toBe(2);
    expect((await preview(ws2.ctx, { source: 'jobs', fields: ['jobNumber'], locationIds: [second] })).total).toBe(1);
    const m = await memberWithPermissions(ws2, ['report.view', 'report.create_custom', 'job.view']);
    await ownerQuery('UPDATE memberships SET all_locations = false WHERE id = $1', [m.ctx.membership.id]);
    await withTenant(ws2.businessId, (tx) => tx.membershipLocation.create({ data: { membershipId: m.ctx.membership.id, locationId: main } }));
    const mine = await businessContext(m.user);
    expect((await preview(mine, { source: 'jobs', fields: ['jobNumber'] })).total).toBe(1);
    expect((await err(preview(mine, { source: 'jobs', fields: ['jobNumber'], locationIds: [second] }))).status).toBe(403);
  });
});

describe('saved reports', () => {
  it('private reports are visible only to their owner; sharing is explicit', async () => {
    const owner = await memberWithPermissions(ws, ['report.view', 'report.create_custom', 'job.view']);
    const other = await memberWithPermissions(ws, ['report.view', 'job.view']);
    const cfg = { source: 'jobs', fields: ['jobNumber', 'status'] };
    const { id } = await createSavedReport(owner.ctx, { kind: 'CUSTOM', name: 'My jobs', config: cfg });
    expect((await listSavedReports(owner.ctx)).map((r) => r.id)).toContain(id);
    expect((await listSavedReports(other.ctx)).map((r) => r.id)).not.toContain(id);
    expect((await err(runSavedReport(other.ctx, id))).status).toBe(404);
    // share with the other member
    await updateSavedReport(owner.ctx, id, { visibility: 'SHARED', sharedMembershipIds: [other.ctx.membership.id] });
    expect((await listSavedReports(other.ctx)).map((r) => r.id)).toContain(id);
    expect((await runSavedReport(other.ctx, id)).total).toBe(3);
    // the viewer cannot change or remove it
    expect((await err(updateSavedReport(other.ctx, id, { name: 'Hijack' }))).status).toBe(403);
    expect((await err(archiveSavedReport(other.ctx, id))).status).toBe(403);
    await archiveSavedReport(owner.ctx, id);
    expect((await listSavedReports(owner.ctx)).map((r) => r.id)).not.toContain(id);
  });

  it('sharing never shares data: a viewer without a field cannot run the report', async () => {
    const author = await memberWithPermissions(ws, ['report.view', 'report.create_custom', 'job.view', 'finance.view_reports']);
    const viewer = await memberWithPermissions(ws, ['report.view', 'job.view']);
    const { id } = await createSavedReport(author.ctx, { kind: 'CUSTOM', name: 'Jobs with value', config: { source: 'jobs', fields: ['jobNumber', 'invoiced'] }, visibility: 'SHARED', sharedMembershipIds: [viewer.ctx.membership.id] });
    expect((await runSavedReport(author.ctx, id)).total).toBe(3);
    const e = await err(runSavedReport(viewer.ctx, id));
    expect(e.status).toBe(403);
    // the figures are not in the error
    expect(JSON.stringify(e)).not.toMatch(/100000|200000|300000/);
  });

  it('business-wide sharing needs report.manage; the author must hold what the report uses', async () => {
    const author = await memberWithPermissions(ws, ['report.view', 'report.create_custom', 'job.view']);
    expect((await err(createSavedReport(author.ctx, { kind: 'CUSTOM', name: 'All', config: { source: 'jobs', fields: ['jobNumber'] }, visibility: 'BUSINESS' }))).status).toBe(403);
    expect((await err(createSavedReport(author.ctx, { kind: 'CUSTOM', name: 'Money', config: { source: 'jobs', fields: ['invoiced'] } }))).status).toBe(403);
    expect((await err(createSavedReport(author.ctx, { kind: 'CUSTOM', name: 'Shared', config: { source: 'jobs', fields: ['jobNumber'] }, visibility: 'SHARED' }))).status).toBe(422);
    const admin = ws.ctx;
    const { id } = await createSavedReport(admin, { kind: 'CUSTOM', name: 'Everyone', config: { source: 'jobs', fields: ['jobNumber'] }, visibility: 'BUSINESS' });
    expect((await listSavedReports(author.ctx)).map((r) => r.id)).toContain(id);
  });

  it('a standard report can be saved with its filters', async () => {
    const { id } = await createSavedReport(ws.ctx, { kind: 'STANDARD', reportKey: 'invoices', name: 'Overdue and unpaid', config: { preset: 'THIS_YEAR', invoiceStatus: 'UNPAID' } });
    const r = await runSavedReport(ws.ctx, id);
    expect(r.key).toBe('invoices');
    expect(r.title).toBe('Overdue and unpaid');
    expect(r.total).toBe(2);
    // a report you cannot run cannot be saved
    const m = await memberWithPermissions(ws, ['report.view', 'job.view']);
    expect((await err(createSavedReport(m.ctx, { kind: 'STANDARD', reportKey: 'revenue', name: 'No', config: {} }))).status).toBe(403);
  });
});
