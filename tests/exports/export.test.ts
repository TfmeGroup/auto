import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { listExports, openExport, exportableDatasets } from '@/server/exports/service';
import { createCustomer } from '@/server/customers/service';
import { uploadFile } from '@/server/files/service';
import { clearPlatformSettingsCache } from '@/server/settings/platform';
import { POST as requestRoute, GET as listRoute } from '@/app/api/v1/exports/route';
import { GET as downloadRoute } from '@/app/api/v1/exports/[id]/download/route';
import { call } from '../helpers/http';
import { businessContext, createMemberCtx, createWorkspace, drainJobs, ownerQuery, sentTo, type TestWorkspace } from '../helpers/factory';
import { customerInput } from '../helpers/customers';
import { pngOf } from '../helpers/images';

afterAll(disconnectPrisma);

const PNG = pngOf(64, 3);

async function onPlan(ws: TestWorkspace, planKey: 'solo' | 'team' | 'business') {
  await ownerQuery(`UPDATE subscriptions SET status='ACTIVE', trial_ends_at=NULL, current_period_end=now()+interval '30 days', plan_id=(SELECT id FROM plans WHERE key=$2) WHERE business_id=$1`, [ws.businessId, planKey]);
  ws.ctx = await businessContext(ws.owner);
}

async function exportOf(ws: TestWorkspace, token = ws.ctx.token, datasets?: string[]) {
  const res = await call(requestRoute, { token, body: datasets ? { datasets } : {} });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await drainJobs();
  const dl = await call(downloadRoute, { token, params: { id: res.body.data.id } });
  return { id: res.body.data.id as string, dl, json: dl.status === 200 ? JSON.parse(await dl.raw.clone().text()) : null };
}

describe('business data export', () => {
  it('is generated in the background, then downloadable: the request itself never blocks on the work', async () => {
    const ws = await createWorkspace('Export Co');
    await createCustomer(ws.ctx, customerInput('Exported Person', { email: 'ep@example.test', phone: '082 000 1111' }));
    const res = await call(requestRoute, { token: ws.ctx.token, body: {} });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING'); // returned immediately, before any generation
    expect((await call(downloadRoute, { token: ws.ctx.token, params: { id: res.body.data.id } })).status).toBe(404); // not ready yet

    await drainJobs();
    const list = await listExports(ws.ctx, {});
    expect(list.items[0]).toMatchObject({ status: 'READY', scope: expect.arrayContaining(['customers', 'team', 'business']) });
    const dl = await call(downloadRoute, { token: ws.ctx.token, params: { id: res.body.data.id } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="tfme-auto-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(dl.headers.get('cache-control')).toMatch(/no-store/);
    const body = JSON.parse(await dl.raw.clone().text());
    expect(body.business).toBe('Export Co');
    expect(body.datasets.customers).toHaveLength(1);
    expect(body.datasets.customers[0]).toMatchObject({ name: 'Exported Person', email: 'ep@example.test' });
    expect(sentTo(ws.owner.email).some((m) => /export is ready/i.test(m.subject))).toBe(true);
  });

  it('contains ONLY this business’s data — never another business’s', async () => {
    const a = await createWorkspace('Export Iso A');
    const b = await createWorkspace('Export Iso B');
    await createCustomer(a.ctx, customerInput('Alpha Only Person'));
    await createCustomer(b.ctx, customerInput('Bravo Only Person'));
    await uploadFile(b.ctx, { data: PNG, filename: 'bravo-secret.png' });
    const { json } = await exportOf(a);
    const text = JSON.stringify(json);
    expect(text).toContain('Alpha Only Person');
    expect(text).not.toContain('Bravo');
    expect(text).not.toContain('bravo-secret');
    expect(text).not.toContain(b.businessId);
    expect(json.datasets.team.every((m: { email: string }) => m.email !== b.owner.email)).toBe(true);
  });

  it('never includes secrets: password hashes, tokens, storage keys, billing refs', async () => {
    const ws = await createWorkspace('Export Secrets Co');
    await uploadFile(ws.ctx, { data: PNG, filename: 'doc.png' });
    await ownerQuery("UPDATE subscriptions SET provider_subscription_ref = 'tok_EXPORT_LEAK' WHERE business_id = $1", [ws.businessId]);
    const { json } = await exportOf(ws);
    const text = JSON.stringify(json);
    for (const bad of [/passwordHash|password_hash|\$argon2/i, /tokenHash|token_hash|inviteToken/i, /storageKey|storage_key/i, /tok_EXPORT_LEAK/, /mfaSecret|mfa_secret/i]) expect(text).not.toMatch(bad);
    expect(json.datasets.documents[0]).toMatchObject({ originalName: 'doc.png' });
  });

  it('each dataset needs its own permission: a requester only ever gets what they may see', async () => {
    const ws = await createWorkspace('Scoped Export Co');
    await createCustomer(ws.ctx, customerInput('Scoped Customer'));
    const admin = await createMemberCtx(ws, 'admin');
    const manager = await createMemberCtx(ws, 'manager');
    const acct = await createMemberCtx(ws, 'accounts');

    // Managers and accountants lack business.export outright.
    expect((await call(requestRoute, { token: manager.ctx.token, body: {} })).status).toBe(403);
    expect((await call(requestRoute, { token: acct.ctx.token, body: {} })).status).toBe(403);

    // Admin has everything; asking for a dataset they hold works, an unknown one does not.
    expect(exportableDatasets(admin.ctx).map((d) => d.key).sort()).toEqual([
      'audit', 'bookings', 'business', 'customers', 'diagnoses', 'documents', 'inspection_items', 'inspections', 'job_labour_pricing', 'job_notes',
      'job_parts_labour_pricing', 'jobs', 'parts', 'parts_costs', 'purchase_orders', 'recommended_work', 'stock_levels', 'stock_movements', 'suppliers', 'team', 'time_entries', 'vehicle_mileage', 'vehicles',
    ]);
    expect((await call(requestRoute, { token: admin.ctx.token, body: { datasets: ['nonsense'] } })).status).toBe(422);

    // A custom-trimmed permission set limits the scope: drop audit.view from a role and the audit dataset disappears.
    await ownerQuery("DELETE FROM role_permissions WHERE permission = 'audit.view' AND role_id = (SELECT id FROM roles WHERE key='admin' AND business_id IS NULL)");
    try {
      const trimmed = await businessContext(admin.user);
      expect(exportableDatasets(trimmed).map((d) => d.key)).not.toContain('audit');
      const forbidden = await call(requestRoute, { token: trimmed.token, body: { datasets: ['audit'] } });
      expect(forbidden.status).toBe(403);
    } finally {
      await ownerQuery("INSERT INTO role_permissions (role_id, permission) SELECT id, 'audit.view' FROM roles WHERE key='admin' AND business_id IS NULL ON CONFLICT DO NOTHING");
    }
  });

  it('needs the data_export entitlement and the business.export permission', async () => {
    const ws = await createWorkspace('Plan Export Co');
    const tech = await createMemberCtx(ws, 'technician');
    expect((await call(requestRoute, { token: tech.ctx.token, body: {} })).status).toBe(403);
    await ownerQuery("DELETE FROM plan_features WHERE feature_key = 'data_export' AND plan_id = (SELECT id FROM plans WHERE key='solo')");
    try {
      await onPlan(ws, 'solo');
      const res = await call(requestRoute, { token: ws.ctx.token, body: {} });
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    } finally {
      await ownerQuery("INSERT INTO plan_features (plan_id, feature_key, enabled) SELECT id, 'data_export', true FROM plans WHERE key='solo' ON CONFLICT DO NOTHING");
    }
  });

  it('still works when the subscription has expired (customers can always take their data)', async () => {
    const ws = await createWorkspace('Expired Export Co');
    await createCustomer(ws.ctx, customerInput('Keep My Data'));
    await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() - interval '2 days' WHERE business_id = $1", [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    expect(ws.ctx.subscription.canWrite).toBe(false);
    const { json } = await exportOf(ws);
    expect(json.datasets.customers[0].name).toBe('Keep My Data');
  });

  it('another business cannot list, see or download your export; strangers are refused', async () => {
    const a = await createWorkspace('Export Owner A');
    const b = await createWorkspace('Export Thief B');
    await createCustomer(a.ctx, customerInput('Private A'));
    const { id } = await exportOf(a);
    expect((await call(downloadRoute, { token: b.ctx.token, params: { id } })).status).toBe(404);
    expect((await call(downloadRoute, { params: { id } })).status).toBe(401);
    const bList = await call(listRoute, { token: b.ctx.token });
    expect(bList.body.data.map((x: { id: string }) => x.id)).not.toContain(id);
    await expect(openExport(b.ctx, id)).rejects.toMatchObject({ status: 404 });
    expect((await call(downloadRoute, { token: a.ctx.token, params: { id: 'not-a-uuid' } })).status).toBe(422);
  });

  it('expires: after the retention window the download is gone', async () => {
    const ws = await createWorkspace('Expiring Export Co');
    const { id } = await exportOf(ws);
    expect((await call(downloadRoute, { token: ws.ctx.token, params: { id } })).status).toBe(200);
    await ownerQuery("UPDATE data_exports SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    expect((await call(downloadRoute, { token: ws.ctx.token, params: { id } })).status).toBe(404);
    expect((await listExports(ws.ctx, {})).items.find((i) => i.id === id)?.status).toBe('EXPIRED');
  });

  it('the retention window is a platform setting', async () => {
    const ws = await createWorkspace('Retention Export Co');
    await ownerQuery("INSERT INTO platform_settings (key, value, updated_at) VALUES ('export_retention_days', '1', now()) ON CONFLICT (key) DO UPDATE SET value = '1'");
    clearPlatformSettingsCache();
    try {
      const { id } = await exportOf(ws);
      const row = (await ownerQuery('SELECT requested_at, expires_at FROM data_exports WHERE id = $1', [id])).rows[0]!;
      const hours = (new Date(row.expires_at).getTime() - new Date(row.requested_at).getTime()) / 3_600_000;
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThan(25);
    } finally {
      await ownerQuery("DELETE FROM platform_settings WHERE key = 'export_retention_days'");
      clearPlatformSettingsCache();
    }
  });

  it('is rate limited, recorded in the audit log (request + completion + each download), and the stored file is integrity-checked', async () => {
    const ws = await createWorkspace('Audited Export Co');
    const { id } = await exportOf(ws);
    await call(downloadRoute, { token: ws.ctx.token, params: { id } });
    const actions = (await ownerQuery("SELECT action FROM audit_logs WHERE business_id = $1 AND action LIKE 'data.%'", [ws.businessId])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['data.export_requested', 'data.exported', 'data.export_downloaded']));
    const row = (await ownerQuery('SELECT sha256, size_bytes, storage_key FROM data_exports WHERE id = $1', [id])).rows[0]!;
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.size_bytes).toBeGreaterThan(10);
    expect(row.storage_key.startsWith(`${ws.businessId}/`)).toBe(true);

    let blocked = false;
    for (let i = 0; i < 4; i++) {
      const r = await call(requestRoute, { token: ws.ctx.token, body: {} });
      if (r.status === 429) { blocked = true; break; }
    }
    expect(blocked).toBe(true);
  });

  it('pages through large datasets without losing or duplicating rows', async () => {
    const ws = await createWorkspace('Big Export Co');
    await ownerQuery(
      `INSERT INTO customers (business_id, customer_number, name, updated_at)
       SELECT $1, 'BULK-' || g, 'Bulk ' || g, now() FROM generate_series(1, 2300) g`,
      [ws.businessId],
    );
    const { json } = await exportOf(ws, ws.ctx.token, ['customers']);
    expect(json.datasets.customers).toHaveLength(2300);
    expect(new Set(json.datasets.customers.map((c: { id: string }) => c.id)).size).toBe(2300);
  });
});
