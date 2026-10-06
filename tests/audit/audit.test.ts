import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma, withTenant } from '@/server/db/client';
import { recordAudit, sanitizeForAudit } from '@/server/audit/audit';
import { listAuditLog } from '@/server/audit/service';
import { createCustomer } from '@/server/customers/service';
import { changeMemberRole, inviteMember } from '@/server/memberships/service';
import { GET as auditRoute } from '@/app/api/v1/audit/route';
import { call } from '../helpers/http';
import { createMemberCtx, createWorkspace, ownerQuery, uniqueEmail } from '../helpers/factory';
import { customerInput } from '../helpers/customers';

afterAll(disconnectPrisma);

describe('audit logging', () => {
  it('records who, what, which record, when, and request context', async () => {
    const ws = await createWorkspace('Audit Detail Co');
    const c = await createCustomer(ws.ctx, customerInput('Detail Customer'));
    const row = (await ownerQuery('SELECT * FROM audit_logs WHERE resource_id = $1', [c.id])).rows[0];
    expect(row).toMatchObject({
      business_id: ws.businessId, user_id: ws.owner.id, action: 'customer.created', resource_type: 'customer', resource_id: c.id,
    });
    expect(row.request_id).toBeTruthy();
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.after.name).toBe('Detail Customer');
  });

  it('is atomic with the change it describes: a rolled-back action leaves no audit row and vice versa', async () => {
    const ws = await createWorkspace('Audit Atomic Co');
    await expect(
      withTenant(ws.businessId, async (tx) => {
        const cust = await tx.customer.create({ data: { businessId: ws.businessId, customerNumber: 'CUST-ATOMIC', name: 'Rolled Back' } });
        await recordAudit(tx, ws.ctx.meta, { action: 'customer.created', businessId: ws.businessId, userId: ws.owner.id, resourceType: 'customer', resourceId: cust.id });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await ownerQuery("SELECT 1 FROM customers WHERE customer_number = 'CUST-ATOMIC'")).rowCount).toBe(0);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND resource_type = 'customer'", [ws.businessId])).rowCount).toBe(0);
  });

  it('never stores secrets in audit snapshots', () => {
    const snap = sanitizeForAudit({ id: 1, passwordHash: '$argon2id$abc', nested: { token: 'raw-token', inviteTokenHash: 'h', ok: 'keep' }, list: [{ secret: 's' }] }) as Record<string, unknown>;
    expect(JSON.stringify(snap)).not.toMatch(/argon2|raw-token|"h"|"s"/);
    expect(JSON.stringify(snap)).toContain('keep');
    expect(sanitizeForAudit(undefined)).toBeUndefined();
  });

  it('captures sensitive business events: invites and role changes', async () => {
    const ws = await createWorkspace('Audit Events Co');
    const adminRole = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'admin' } });
    const techRole = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    await inviteMember(ws.ctx, { email: uniqueEmail('aud'), roleId: techRole.id });
    const m = await createMemberCtx(ws, 'technician');
    await changeMemberRole(ws.ctx, m.ctx.membership.id, { roleId: adminRole.id });
    const rows = (await ownerQuery("SELECT action, before, after, metadata FROM audit_logs WHERE business_id = $1 AND action IN ('member.invited','member.role_changed')", [ws.businessId])).rows;
    const change = rows.find((r) => r.action === 'member.role_changed');
    expect(change?.before.roleKey).toBe('technician');
    expect(change?.after.roleKey).toBe('admin');
    expect(rows.find((r) => r.action === 'member.invited')?.metadata.roleKey).toBe('technician');
    expect(JSON.stringify(rows)).not.toMatch(/tokenHash|token_hash/);
  });
});

describe('viewing the audit trail', () => {
  it('requires audit.view and is read-only over the API', async () => {
    const ws = await createWorkspace('Audit View Co');
    const tech = await createMemberCtx(ws, 'technician');
    expect((await call(auditRoute, { token: tech.ctx.token })).status).toBe(403);
    expect((await call(auditRoute, { token: ws.ctx.token })).status).toBe(200);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      // The route module exports GET only: there is no write surface to attack.
      const mod = await import('@/app/api/v1/audit/route');
      expect((mod as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('filters by action prefix and paginates newest-first', async () => {
    const ws = await createWorkspace('Audit Filter Co');
    for (let i = 0; i < 3; i++) await createCustomer(ws.ctx, customerInput(`Filter ${i}`));
    const customers = await listAuditLog(ws.ctx, { action: 'customer', pageSize: 2 });
    expect(customers.meta).toMatchObject({ total: 3, pageSize: 2, totalPages: 2 });
    expect(customers.items.every((i) => i.action.startsWith('customer'))).toBe(true);
    expect(customers.items[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(customers.items[1]!.createdAt.getTime());
    expect(customers.items[0]!.user).toBe(ws.owner.name);
    const all = await listAuditLog(ws.ctx, {});
    expect(all.items.some((i) => i.action === 'business.created')).toBe(true);
  });
});

describe('concurrency', () => {
  it('parallel customer creation yields unique, gapless numbers', async () => {
    const ws = await createWorkspace('Concurrent Numbers Co');
    const made = await Promise.all(Array.from({ length: 15 }, (_, i) => createCustomer(ws.ctx, customerInput(`Parallel ${i}`))));
    const numbers = made.map((c) => c.customerNumber).sort();
    expect(new Set(numbers).size).toBe(15);
    expect(numbers[0]).toBe('CUS-000001');
    expect(numbers[14]).toBe('CUS-000015');
  });

  it('a failed create does not burn a number', async () => {
    const ws = await createWorkspace('Gapless Co');
    await createCustomer(ws.ctx, customerInput('One'));
    await expect(createCustomer(ws.ctx, customerInput(''))).rejects.toMatchObject({ status: 422 }); // fails validation before allocating
    const two = await createCustomer(ws.ctx, customerInput('Two'));
    expect(two.customerNumber).toBe('CUS-000002');
  });
});
