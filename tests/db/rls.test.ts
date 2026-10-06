import { afterAll, describe, expect, it } from 'vitest';
import { appClient, createWorkspace, ownerQuery } from '../helpers/factory';
import { customerInput } from '../helpers/customers';
import { createCustomer } from '@/server/customers/service';
import { disconnectPrisma } from '@/server/db/client';

afterAll(disconnectPrisma);

describe('database foundation', () => {
  it('migrations applied and system roles/plans are synced', async () => {
    const roles = await ownerQuery<{ key: string }>('SELECT key FROM roles WHERE business_id IS NULL ORDER BY key');
    expect(roles.rows.map((r) => r.key)).toEqual(
      ['accounts', 'admin', 'inventory_staff', 'manager', 'owner', 'service_advisor', 'technician'],
    );
    const plans = await ownerQuery<{ key: string }>('SELECT key FROM plans');
    expect(plans.rows.map((r) => r.key)).toContain('trial');
  });

  it('the app role is not a superuser and does not bypass RLS', async () => {
    const c = await appClient();
    const r = await c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    await c.end();
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('authorization reference data is owner-managed', () => {
  it('the app role cannot edit system roles, grant itself permissions, or change plan limits', async () => {
    const c = await appClient();
    // System roles are protected by triggers (custom roles are writable by the app, so grants alone cannot separate them).
    await expect(c.query("UPDATE roles SET name = 'x' WHERE business_id IS NULL")).rejects.toThrow(/managed by migrations/i);
    await expect(c.query('DELETE FROM roles WHERE is_system')).rejects.toThrow(/managed by migrations/i);
    await expect(c.query("INSERT INTO role_permissions (role_id, permission) SELECT id, 'business.close' FROM roles WHERE key = 'technician' AND business_id IS NULL")).rejects.toThrow(/managed by migrations/i);
    await expect(c.query('DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE business_id IS NULL)')).rejects.toThrow(/managed by migrations/i);
    await expect(c.query("INSERT INTO roles (business_id, key, name, is_system, updated_at) VALUES (NULL, 'sneaky', 'Sneaky', false, now())")).rejects.toThrow(/only create business-owned/i);
    // Pricing, entitlements and platform tunables are owner-managed outright.
    await expect(c.query('UPDATE plans SET max_members = 100000')).rejects.toThrow(/permission denied/i);
    await expect(c.query("INSERT INTO plan_features (plan_id, feature_key) SELECT id, 'x' FROM plans LIMIT 1")).rejects.toThrow(/permission denied/i);
    await expect(c.query("INSERT INTO platform_settings (key, value, updated_at) VALUES ('grace_days', '9999', now())")).rejects.toThrow(/permission denied/i);
    await expect(c.query('INSERT INTO platform_admins (user_id) SELECT id FROM users LIMIT 1')).rejects.toThrow(/permission denied/i);
    await c.end();
  });
});

describe('row-level security (defence in depth below the application code)', () => {
  it('returns no tenant rows when no tenant context is set', async () => {
    const ws = await createWorkspace('RLS Co A');
    await createCustomer(ws.ctx, customerInput('Visible Only In Tenant'));
    const c = await appClient();
    const r = await c.query('SELECT count(*)::int AS n FROM customers');
    await c.end();
    expect(r.rows[0].n).toBe(0); // forgot withTenant()? fail closed.
  });

  it('shows only the current tenant, even for `SELECT *` with no WHERE', async () => {
    const a = await createWorkspace('RLS Co B1');
    const b = await createWorkspace('RLS Co B2');
    await createCustomer(a.ctx, customerInput('Alpha Customer'));
    await createCustomer(b.ctx, customerInput('Bravo Customer'));

    const c = await appClient();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true)", [a.businessId]);
    const rows = await c.query('SELECT name, business_id FROM customers');
    await c.query('ROLLBACK');
    await c.end();

    expect(rows.rows.map((r) => r.name)).toEqual(['Alpha Customer']);
    expect(rows.rows.every((r) => r.business_id === a.businessId)).toBe(true);
  });

  it('rejects writing a row for a different tenant than the current context', async () => {
    const a = await createWorkspace('RLS Co C1');
    const b = await createWorkspace('RLS Co C2');
    const c = await appClient();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true)", [a.businessId]);
    await expect(
      c.query(
        "INSERT INTO customers (business_id, customer_number, name, updated_at) VALUES ($1, 'CUST-9999', 'Smuggled', now())",
        [b.businessId],
      ),
    ).rejects.toThrow(/row-level security/i);
    await c.query('ROLLBACK');
    await c.end();
  });

  it('cannot update or delete another tenant’s rows', async () => {
    const a = await createWorkspace('RLS Co D1');
    const b = await createWorkspace('RLS Co D2');
    const victim = await createCustomer(b.ctx, customerInput('Victim'));

    const c = await appClient();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true)", [a.businessId]);
    const upd = await c.query("UPDATE customers SET name = 'Hacked' WHERE id = $1", [victim.id]);
    const del = await c.query('DELETE FROM customers WHERE id = $1', [victim.id]);
    await c.query('COMMIT');
    await c.end();

    expect(upd.rowCount).toBe(0);
    expect(del.rowCount).toBe(0);
    const still = await ownerQuery('SELECT name FROM customers WHERE id = $1', [victim.id]);
    expect(still.rows[0]?.name).toBe('Victim Tester');
  });

  it('every table with a business_id column has RLS enabled and forced (guard for future modules)', async () => {
    // Control-plane tables are guarded by service code + tests instead. Adding a
    // table to this list is a deliberate, reviewed decision.
    const CONTROL_PLANE = new Set([
      'memberships', 'roles', 'businesses', 'subscriptions', 'subscription_payments', 'jobs',
    ]);
    const r = await ownerQuery<{ table_name: string; rls: boolean; forced: boolean }>(`
      SELECT c.table_name, cl.relrowsecurity AS rls, cl.relforcerowsecurity AS forced
        FROM information_schema.columns c
        JOIN pg_class cl ON cl.relname = c.table_name AND cl.relkind = 'r'
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
       WHERE c.table_schema = 'public' AND c.column_name = 'business_id'`);
    const unprotected = r.rows.filter((t) => !CONTROL_PLANE.has(t.table_name) && !(t.rls && t.forced));
    expect(unprotected.map((t) => t.table_name)).toEqual([]);
  });
});

describe('audit log is append-only', () => {
  it('the app role cannot UPDATE, DELETE or TRUNCATE audit rows', async () => {
    const ws = await createWorkspace('Audit Co');
    const c = await appClient();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true)", [ws.businessId]);
    const rows = await c.query('SELECT id FROM audit_logs');
    expect(rows.rowCount).toBeGreaterThan(0);
    await expect(c.query("UPDATE audit_logs SET action = 'tampered'")).rejects.toThrow(/permission denied/i);
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await expect(c.query('DELETE FROM audit_logs')).rejects.toThrow(/permission denied/i);
    await c.query('ROLLBACK');
    await expect(c.query('TRUNCATE audit_logs')).rejects.toThrow(/permission denied/i);
    await c.end();
  });

  it('even the schema owner is blocked by the immutability trigger', async () => {
    await createWorkspace('Audit Co 2');
    await expect(ownerQuery("UPDATE audit_logs SET action = 'tampered'")).rejects.toThrow(/append-only/i);
    await expect(ownerQuery('DELETE FROM audit_logs')).rejects.toThrow(/append-only/i);
    await expect(ownerQuery('TRUNCATE audit_logs')).rejects.toThrow(/append-only/i);
  });
});
