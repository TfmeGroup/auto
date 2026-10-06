import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { GET as savedGET } from '@/app/api/v1/reports/saved/[id]/route';
import { GET as reportGET } from '@/app/api/v1/reports/[key]/route';
import { GET as reportExportGET } from '@/app/api/v1/reports/[key]/export/route';
import { GET as overviewGET } from '@/app/api/v1/admin/overview/route';
import { GET as schemaGET } from '@/app/api/v1/reports/custom/schema/route';
import { GET as finSettingsGET, PATCH as finSettingsPATCH } from '@/app/api/v1/finance/settings/route';
import { runReport } from '@/server/reports/run';
import { createSavedReport } from '@/server/reports/saved';
import { SOURCES } from '@/server/reports/custom/schema';
import { call } from '../helpers/http';
import { createMemberCtx, ownerQuery, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice } from '../helpers/finance';
import { memberWithPermissions } from '../helpers/workshop';

afterAll(disconnectPrisma);

const NOPE = '00000000-0000-4000-8000-000000000000';
let A: TestWorkspace;
let B: TestWorkspace;
let tech: Awaited<ReturnType<typeof createMemberCtx>>;
let advisor: Awaited<ReturnType<typeof createMemberCtx>>;

beforeAll(async () => {
  A = await financeWorkspace('P7 Shop A', { vat: true });
  await upgradePlan(A, 'business');
  B = await financeWorkspace('P7 Shop B');
  await upgradePlan(B, 'business');
  tech = await createMemberCtx(A, 'technician');
  advisor = await createMemberCtx(A, 'service_advisor');
  await issuedInvoice(A, { lines: [L('Brake pads', 1, 100_000, { unitCostCents: 40_000 })] });
});

// Every route added in Part 7, found on disk so a future route cannot be forgotten.
const routeModules = import.meta.glob('/src/app/api/v1/{reports,settings,admin,imports}/**/route.ts');
const extra = import.meta.glob('/src/app/api/v1/jobs/from-template/route.ts');
const all = { ...routeModules, ...extra };

describe('every Part 7 endpoint is guarded by the shared route wrapper', () => {
  it('declares business access and a permission (or an explicit, reviewed exemption)', () => {
    const exempt = new Set(['/src/app/api/v1/admin/alerts/route.ts']); // returns only alerts about what the caller may act on
    const files = Object.keys(all);
    expect(files.length).toBeGreaterThan(35);
    for (const f of files) {
      const text = readFileSync(`.${f}`, 'utf8');
      const handlers = [...text.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route\(\{([^}]*)\}/g)];
      expect(handlers.length, f).toBeGreaterThan(0);
      expect(text, f).not.toMatch(/export (async )?function (GET|POST|PATCH|PUT|DELETE)/); // nothing bypasses route()
      for (const h of handlers) {
        expect(h[2], f).toContain("access: 'business'");
        if (!exempt.has(f)) expect(h[2], f).not.toContain('permission: null');
        if (h[1] !== 'GET' && f !== '/src/app/api/v1/reports/custom/run/route.ts') expect(h[2], `${f} ${h[1]} must be write-gated`).toContain('write: true');
      }
    }
  });

  it('refuses every request without a session', async () => {
    for (const [file, load] of Object.entries(all)) {
      const mod = (await load()) as Record<string, (req: Request, x: { params: Promise<Record<string, string>> }) => Promise<Response>>;
      for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        if (!mod[m]) continue;
        const r = await call(mod[m] as never, { method: m, body: m === 'GET' ? undefined : {}, params: { id: NOPE, key: 'revenue', kind: 'customers' } });
        expect(r.status, `${m} ${file}`).toBe(401);
      }
    }
  });

  it('refuses a technician everywhere they have no permission, and never leaks data to them', async () => {
    const allowed: Record<string, number> = { 'GET /src/app/api/v1/admin/alerts/route.ts': 200, 'GET /src/app/api/v1/settings/job-templates/route.ts': 200 };
    for (const [file, load] of Object.entries(all)) {
      const mod = (await load()) as Record<string, (req: Request, x: { params: Promise<Record<string, string>> }) => Promise<Response>>;
      for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        if (!mod[m]) continue;
        const r = await call(mod[m] as never, { method: m, token: tech.ctx.token, body: m === 'GET' ? undefined : {}, params: { id: NOPE, key: 'revenue', kind: 'customers' } });
        expect(r.status, `${m} ${file}`).toBe(allowed[`${m} ${file}`] ?? 403);
      }
    }
  });

  it('refuses state-changing requests from another site', async () => {
    const mod = (await all['/src/app/api/v1/settings/numbering/route.ts']!()) as { PATCH: never };
    const r = await call(mod.PATCH, { method: 'PATCH', token: A.ctx.token, origin: 'https://evil.example', body: { customerPrefix: 'EVIL' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_REJECTED');
  });
});

describe('cross-business and cross-location access', () => {
  it('another business cannot open, run or export a saved report by id', async () => {
    const { id } = await createSavedReport(A.ctx, { kind: 'STANDARD', reportKey: 'invoices', name: 'A only', config: { preset: 'THIS_YEAR' } });
    expect((await call(savedGET, { token: A.ctx.token, params: { id } })).status).toBe(200);
    expect((await call(savedGET, { token: B.ctx.token, params: { id } })).status).toBe(404);
    const run = await import('@/app/api/v1/reports/saved/[id]/run/route');
    expect((await call(run.GET as never, { token: B.ctx.token, params: { id } })).status).toBe(404);
    const exp = await import('@/app/api/v1/reports/saved/[id]/export/route');
    expect((await call(exp.GET as never, { token: B.ctx.token, params: { id } })).status).toBe(404);
  });

  it('a report names no other business\'s records even when asked by id', async () => {
    const foreign = (await ownerQuery<{ id: string }>('SELECT id FROM customers WHERE business_id = $1 LIMIT 1', [A.businessId])).rows[0]!.id;
    const r = await call(reportGET, { token: B.ctx.token, params: { key: 'invoices' }, query: { preset: 'THIS_YEAR', customerId: foreign } });
    expect(r.status).toBe(200);
    expect(r.body.data.rows).toHaveLength(0);
    expect(JSON.stringify(r.body)).not.toContain('P7 Shop A');
  });

  it('a member limited to one location cannot ask for another', async () => {
    const second = (await ownerQuery<{ id: string }>("INSERT INTO locations (business_id, name, status, updated_at) VALUES ($1, 'Far branch', 'ACTIVE', now()) RETURNING id", [A.businessId])).rows[0]!.id;
    const m = await memberWithPermissions(A, ['report.view', 'job.view']);
    await ownerQuery('UPDATE memberships SET all_locations = false WHERE id = $1', [m.ctx.membership.id]);
    const r = await call(reportGET, { token: m.ctx.token, params: { key: 'jobs' }, query: { locationIds: second } });
    expect(r.status).toBe(403);
    const other = await call(reportGET, { token: m.ctx.token, params: { key: 'jobs' }, query: { preset: 'THIS_YEAR' } });
    expect(other.status).toBe(200); // their own scope works
  });
});

describe('financial and cost visibility', () => {
  it('an advisor cannot open financial or profit reports, and a role without cost permission never receives cost columns', async () => {
    expect((await call(reportGET, { token: advisor.ctx.token, params: { key: 'revenue' } })).status).toBe(403);
    expect((await call(reportGET, { token: advisor.ctx.token, params: { key: 'profitability' } })).status).toBe(403);
    expect((await call(reportExportGET, { token: advisor.ctx.token, params: { key: 'revenue' } })).status).toBe(403);
    const viewer = await memberWithPermissions(A, ['report.view', 'inventory.view']);
    const stock = await call(reportGET, { token: viewer.ctx.token, params: { key: 'stock' } });
    expect(stock.status).toBe(200);
    const seen = [...stock.body.data.columns.map((c: { key: string; label: string }) => c.key + ' ' + c.label), ...stock.body.data.summary.map((s: { key: string; label: string }) => s.key + ' ' + s.label)].join(' ');
    expect(seen).not.toMatch(/cost|value/i);
  });

  it('exports are refused without report.export, and without the financial export permission for money reports', async () => {
    const noExport = await memberWithPermissions(A, ['report.view', 'finance.view_reports']);
    expect((await call(reportExportGET, { token: noExport.ctx.token, params: { key: 'revenue' } })).status).toBe(403);
    const halfExport = await memberWithPermissions(A, ['report.view', 'report.export', 'finance.view_reports']);
    expect((await call(reportExportGET, { token: halfExport.ctx.token, params: { key: 'revenue' } })).status).toBe(403);
    const accounts = await createMemberCtx(A, 'accounts');
    const ok = await call(reportExportGET, { token: accounts.ctx.token, params: { key: 'revenue' }, query: { preset: 'THIS_YEAR', format: 'CSV' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-disposition')).toMatch(/attachment/);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('private data stays out of reports and exports', () => {
  it('no report or custom source offers customer contact details, employee contact details or any credential', async () => {
    const banned = /email|mobile|phone|password|hash|token|secret|id number|passport/i;
    const customers = await runReport(A.ctx, 'customers', {});
    expect(customers.columns.map((c) => c.label).join(' ')).not.toMatch(banned);
    const tech1 = await runReport(A.ctx, 'technicians', { preset: 'THIS_YEAR' });
    expect(tech1.columns.map((c) => c.label).join(' ')).not.toMatch(banned);
    const employees = SOURCES.find((s) => s.key === 'employees')!;
    expect(employees.fields.map((f) => f.label).join(' ')).not.toMatch(banned);
    expect(JSON.stringify(customers.rows)).not.toMatch(/@example\.test/); // test customers have emails: none may appear
  });

  it('employee data in a custom report needs employee permission and exposes only name, role, status and join date', async () => {
    const { runPreview } = await import('@/server/reports/saved');
    const r = await runPreview(A.ctx, { name: 'x', config: { source: 'employees', fields: ['name', 'role', 'status', 'joined'] } });
    expect(r.columns.map((c) => c.label)).toEqual(['Name', 'Role', 'Status', 'Joined']);
    expect(JSON.stringify(r.rows)).not.toMatch(/@/);
    const lowly = await memberWithPermissions(A, ['report.view', 'report.create_custom']);
    await expect(runPreview(lowly.ctx, { name: 'x', config: { source: 'employees', fields: ['name'] } })).rejects.toMatchObject({ status: 403 });
    const mgr = await memberWithPermissions(A, ['report.view', 'report.create_custom', 'employee.view']);
    await expect(runPreview(mgr.ctx, { name: 'x', config: { source: 'employees', fields: ['labourCost'] } })).rejects.toMatchObject({ status: 403 }); // cost rate needs labour.view_costs
  });
});

describe('secrets never appear', () => {
  it('payment provider credentials are write-only and absent from every Part 7 response', async () => {
    const secret = 'sk_test_SUPER_SECRET_VALUE_12345';
    const set = await call(finSettingsPATCH, { method: 'PATCH', token: A.ctx.token, body: { onlineProvider: 'payfast', onlineCredentials: { merchantId: '10000100', merchantKey: secret, passphrase: secret } } });
    expect([200, 422]).toContain(set.status);
    const get = await call(finSettingsGET, { token: A.ctx.token });
    expect(JSON.stringify(get.body)).not.toContain(secret);
    for (const [file, load] of Object.entries(all)) {
      const mod = (await load()) as Record<string, never>;
      if (!mod.GET) continue;
      const r = await call(mod.GET, { token: A.ctx.token, params: { id: NOPE, key: 'revenue', kind: 'customers' } });
      expect(JSON.stringify(r.body), file).not.toContain(secret);
    }
    const ov = await call(overviewGET, { token: A.ctx.token });
    expect(JSON.stringify(ov.body)).not.toMatch(/credential|merchantKey|passphrase|secret/i);
    const schema = await call(schemaGET, { token: A.ctx.token });
    expect(JSON.stringify(schema.body)).not.toMatch(/credential|merchantKey|passphrase|secret|password|token/i);
    // and none of it reached the audit log
    const audit = await ownerQuery<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND (before::text LIKE '%' || $2 || '%' OR after::text LIKE '%' || $2 || '%' OR metadata::text LIKE '%' || $2 || '%')", [A.businessId, secret]);
    expect(audit.rows[0]!.n).toBe(0);
  });
});

describe('the audit log cannot be changed through the application', () => {
  it('has no write endpoint, and the database refuses edits and deletes', async () => {
    const mods = Object.keys(all).filter((f) => f.includes('/admin/audit'));
    expect(mods.length).toBeGreaterThan(0);
    for (const f of mods) expect(readFileSync(`.${f}`, 'utf8')).not.toMatch(/export const (POST|PATCH|PUT|DELETE)/);
    const row = (await ownerQuery<{ id: string }>('SELECT id FROM audit_logs WHERE business_id = $1 LIMIT 1', [A.businessId])).rows[0]!;
    await expect(ownerQuery("UPDATE audit_logs SET action = 'x' WHERE id = $1", [row.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM audit_logs WHERE id = $1', [row.id])).rejects.toThrow();
  });
});

describe('custom reports cannot bypass permissions, however the request is made', () => {
  it('through the API a restricted member cannot read a field or source they lack, nor filter on it', async () => {
    const m = await memberWithPermissions(A, ['report.view', 'report.create_custom', 'job.view']);
    const run = await import('@/app/api/v1/reports/custom/run/route');
    const post = (config: Record<string, unknown>) => call(run.POST as never, { method: 'POST', token: m.ctx.token, body: { name: 'x', config } });
    expect((await post({ source: 'jobs', fields: ['jobNumber'] })).status).toBe(200);
    expect((await post({ source: 'jobs', fields: ['jobNumber', 'invoiced'] })).status).toBe(403);
    expect((await post({ source: 'jobs', fields: ['jobNumber'], filters: [{ field: 'invoiced', op: 'gt', value: 0 }] })).status).toBe(403);
    expect((await post({ source: 'invoices', fields: ['number'] })).status).toBe(403);
    expect((await post({ source: 'users', fields: ['email'] })).status).toBe(422);
    expect((await post({ source: 'jobs', fields: ['jobNumber'], sort: [{ column: '1; DROP TABLE jobs' }] })).status).toBe(422);
    const sch = await call(schemaGET, { token: m.ctx.token });
    const keys = sch.body.data.flatMap((s: { fields: { key: string }[] }) => s.fields.map((f) => f.key));
    expect(keys).not.toContain('invoiced');
  });
});

describe('Part 7 setting changes by people without the permission', () => {
  it('changing numbering, retention, security, jobs, vehicles or labour is refused and nothing changes', async () => {
    const before = (await ownerQuery<{ c: string }>('SELECT customer_prefix AS c FROM business_config WHERE business_id = $1', [A.businessId])).rows[0];
    const m = await memberWithPermissions(A, ['settings.view']);
    for (const [path, body] of [['numbering', { customerPrefix: 'HACK' }], ['retention', { trashRetentionDays: 1 }], ['security', { sessionMaxHours: 1 }], ['jobs', { requiredFields: ['complaint'] }], ['vehicles', { mileageRequired: true }], ['labour', { minBillableMinutes: 480 }], ['reporting', { slowMovingDays: 14 }]] as const) {
      const mod = await import(`@/app/api/v1/settings/${path}/route`);
      const r = await call(mod.PATCH as never, { method: 'PATCH', token: m.ctx.token, body });
      expect(r.status, path).toBe(403);
    }
    const after = (await ownerQuery<{ c: string }>('SELECT customer_prefix AS c FROM business_config WHERE business_id = $1', [A.businessId])).rows[0];
    expect(after?.c ?? 'CUS').toBe(before?.c ?? 'CUS');
    void B;
  });
});
