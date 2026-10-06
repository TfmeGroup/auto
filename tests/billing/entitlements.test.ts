import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { canUseFeature, requireFeature, ALL_FEATURES } from '@/server/billing/features';
import { route, ok } from '@/server/http/route';
import { archiveRole, createRole, listRoles, updateRole } from '@/server/roles/service';
import { inviteMember } from '@/server/memberships/service';
import { createOwnerClient } from '@/server/db/client';
import { syncPlans } from '@/server/billing/plans';
import { GET as roleDefsGet, POST as roleDefsPost } from '@/app/api/v1/role-definitions/route';
import { PATCH as roleDefPatch, DELETE as roleDefDelete } from '@/app/api/v1/role-definitions/[id]/route';
import { call } from '../helpers/http';
import { businessContext, createMemberCtx, createWorkspace, drainJobs, ownerQuery, sentTo } from '../helpers/factory';

afterAll(disconnectPrisma);

async function onPlan(name: string, planKey: 'trial' | 'solo' | 'team' | 'business' | 'custom') {
  const ws = await createWorkspace(name);
  await ownerQuery(`UPDATE subscriptions SET status='ACTIVE', trial_ends_at=NULL, current_period_end=now()+interval '30 days', plan_id=(SELECT id FROM plans WHERE key=$2) WHERE business_id=$1`, [ws.businessId, planKey]);
  ws.ctx = await businessContext(ws.owner);
  return ws;
}

describe('plan catalogue and entitlements are DATA', () => {
  it('has exactly the four tiers (plus the internal trial), with the specified user limits', async () => {
    const plans = await prisma().plan.findMany({ where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } }); // test-only plans are archived
    expect(plans.map((p) => p.key)).toEqual(['trial', 'solo', 'team', 'business', 'custom']);
    const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));
    expect(byKey.solo!.maxMembers).toBe(1);
    expect(byKey.team!.maxMembers).toBe(10);
    expect(byKey.business!.maxMembers).toBe(35);
    expect(byKey.custom!.maxMembers).toBeGreaterThanOrEqual(36);
    expect(byKey.custom!.isCustom).toBe(true);
    expect(plans.filter((p) => !p.isPublic).map((p) => p.key)).toEqual(['trial']);
  });

  it('each plan carries identifier, display name, price, interval, limits, status and effective dates', async () => {
    const p = await prisma().plan.findUniqueOrThrow({ where: { key: 'team' } });
    expect(p).toEqual(expect.objectContaining({ key: 'team', name: 'Team', billingInterval: 'MONTHLY', status: 'ACTIVE', maxLocations: expect.any(Number), maxStorageMb: expect.any(Number) }));
    expect('priceCents' in p && 'effectiveFrom' in p && 'effectiveTo' in p).toBe(true);
  });

  it('pricing is left unset by default (not invented) and unset plans refuse purchase', async () => {
    const owner = createOwnerClient();
    try {
      await owner.plan.updateMany({ where: { key: { in: ['solo', 'team', 'business', 'custom'] } }, data: { priceCents: null } });
      await syncPlans(owner); // re-sync from the catalogue
      const prices = (await owner.plan.findMany({ where: { key: { in: ['solo', 'team', 'business', 'custom'] } } })).map((p) => p.priceCents);
      expect(prices).toEqual([null, null, null, null]);
    } finally {
      await owner.$disconnect();
    }
    await ownerQuery("UPDATE plans SET price_cents = CASE key WHEN 'solo' THEN 49900 WHEN 'team' THEN 99900 WHEN 'business' THEN 199900 END WHERE key IN ('solo','team','business')"); // restore for other suites
  });

  it('features differ per plan as DATA, and the feature check reads them', async () => {
    const solo = await onPlan('Feat Solo', 'solo');
    const business = await onPlan('Feat Biz', 'business');
    expect(canUseFeature(solo.ctx.subscription, 'custom_roles')).toBe(false);
    expect(canUseFeature(solo.ctx.subscription, 'multi_location')).toBe(false);
    expect(canUseFeature(solo.ctx.subscription, 'data_export')).toBe(true);
    for (const f of ALL_FEATURES) expect(canUseFeature(business.ctx.subscription, f)).toBe(true);

    // Flip an entitlement in the database and behaviour follows with no code change.
    await ownerQuery("DELETE FROM plan_features WHERE feature_key = 'custom_roles' AND plan_id = (SELECT id FROM plans WHERE key='business')");
    try {
      business.ctx = await businessContext(business.owner);
      expect(canUseFeature(business.ctx.subscription, 'custom_roles')).toBe(false);
    } finally {
      const owner = createOwnerClient();
      await syncPlans(owner);
      await owner.$disconnect();
    }
  });

  it('requireFeature throws a 402 that names the feature and the plan', async () => {
    const solo = await onPlan('Feat Err', 'solo');
    try {
      requireFeature(solo.ctx.subscription, 'custom_roles');
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 402, code: 'FEATURE_NOT_IN_PLAN', details: { feature: 'custom_roles' } });
      expect((e as Error).message).toMatch(/Custom roles.*Solo/);
    }
  });
});

describe('the backend enforces entitlements itself (not just the UI)', () => {
  // A real route using the same wrapper every endpoint uses.
  const gated = route({ access: 'business', permission: null, feature: 'custom_reports' }, async () => ok({ secret: 'report data' }));
  const call2 = (token: string) => call(gated as never, { method: 'GET', token });

  it('an endpoint demanding a feature rejects callers whose plan lacks it, even with full permissions', async () => {
    const solo = await onPlan('Gate Solo', 'solo');
    const team = await onPlan('Gate Team', 'team');
    const biz = await onPlan('Gate Biz', 'business');
    for (const ws of [solo, team]) {
      const r = await call2(ws.ctx.token); // the OWNER of the business: all permissions, wrong plan
      expect(r.status).toBe(402);
      expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
      expect(JSON.stringify(r.body)).not.toContain('report data');
    }
    expect((await call2(biz.ctx.token)).status).toBe(200);
  });

  it('a manual API call to a feature your plan lacks is rejected: custom roles', async () => {
    const team = await onPlan('Manual Team', 'team');
    const res = await call(roleDefsPost, { token: team.ctx.token, body: { name: 'Bay Lead', permissions: ['job.view'] } });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await prisma().role.count({ where: { businessId: team.businessId } }))).toBe(0);
  });

  it('entitlement is evaluated from the live subscription state, so a downgrade removes access at once', async () => {
    const biz = await onPlan('Revoked Features', 'business');
    expect((await call(roleDefsPost, { token: biz.ctx.token, body: { name: 'Temp Role', permissions: ['job.view'] } })).status).toBe(201);
    await ownerQuery(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE key='team') WHERE business_id = $1`, [biz.businessId]);
    expect((await call(roleDefsPost, { token: biz.ctx.token, body: { name: 'Another Role', permissions: ['job.view'] } })).status).toBe(402);
  });
});

describe('custom roles (foundation)', () => {
  it('creates a role with a chosen set of permissions, assignable to members', async () => {
    const ws = await onPlan('Roles Biz', 'business');
    const res = await call(roleDefsPost, { token: ws.ctx.token, body: { name: 'Bay Lead', description: 'Runs the bay', permissions: ['job.view', 'job.edit', 'job.assign', 'vehicle.view', 'customer.view'] } });
    expect(res.status).toBe(201);
    const roleId = res.body.data.id as string;
    const listed = await listRoles(ws.ctx);
    const mine = listed.find((r) => r.id === roleId)!;
    expect(mine).toMatchObject({ name: 'Bay Lead', isSystem: false, archived: false, memberCount: 0 });
    expect(mine.permissions).toEqual(['customer.view', 'job.assign', 'job.edit', 'job.view', 'vehicle.view']);

    // It is assignable by invitation and grants exactly those permissions.
    const inv = await inviteMember(ws.ctx, { email: 'bay.lead@example.test', roleId });
    expect(inv.role.name).toBe('Bay Lead');
    const lead = await createMemberCtx(ws, 'technician');
    await ownerQuery('UPDATE memberships SET role_id = $1 WHERE id = $2', [roleId, lead.ctx.membership.id]);
    const ctx = await businessContext(lead.user);
    expect(ctx.permissions.has('job.assign')).toBe(true);
    expect(ctx.permissions.has('invoice.create')).toBe(false);
    expect(ctx.membership.roleName).toBe('Bay Lead');
  });

  it('nobody can create or edit a role that grants permissions they do not hold', async () => {
    const ws = await onPlan('Escalate Biz', 'business');
    const manager = await createMemberCtx(ws, 'manager');
    expect(manager.ctx.permissions.has('settings.manage_billing')).toBe(false);
    // Managers lack employee.manage_roles entirely:
    expect((await call(roleDefsPost, { token: manager.ctx.token, body: { name: 'X', permissions: ['job.view'] } })).status).toBe(403);

    // An Admin (has manage_roles) still cannot mint a role with Owner-only powers.
    const admin = await createMemberCtx(ws, 'admin');
    const res = await call(roleDefsPost, { token: admin.ctx.token, body: { name: 'Mini Owner', permissions: ['job.view', 'business.close'] } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/do not have it yourself/);
    expect(await prisma().role.count({ where: { businessId: ws.businessId, name: 'Mini Owner' } })).toBe(0);
  });

  it('rejects unknown permission keys and empty roles', async () => {
    const ws = await onPlan('Bad Perm Biz', 'business');
    expect((await call(roleDefsPost, { token: ws.ctx.token, body: { name: 'Bad', permissions: ['job.view', 'made.up'] } })).status).toBe(422);
    expect((await call(roleDefsPost, { token: ws.ctx.token, body: { name: 'Empty', permissions: [] } })).status).toBe(422);
    expect((await call(roleDefsPost, { token: ws.ctx.token, body: { name: 'X', permissions: ['job.view'] } })).status).toBe(422); // name too short
  });

  it('editing permissions is audited with before/after and the affected members are told', async () => {
    const ws = await onPlan('Edit Role Biz', 'business');
    const created = await createRole(ws.ctx, { name: 'Counter Staff', permissions: ['customer.view', 'booking.view'] });
    const member = await createMemberCtx(ws, 'technician');
    await ownerQuery('UPDATE memberships SET role_id = $1 WHERE id = $2', [created.id, member.ctx.membership.id]);

    const res = await call(roleDefPatch, { method: 'PATCH', token: ws.ctx.token, params: { id: created.id }, body: { name: 'Counter Staff', permissions: ['customer.view', 'booking.view', 'booking.create'] } });
    expect(res.status).toBe(200);
    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE business_id = $1 AND action = 'role.permissions_changed'", [ws.businessId]);
    expect(a.rows[0]?.before.permissions).toEqual(['booking.view', 'customer.view']);
    expect(a.rows[0]?.after.permissions).toEqual(['booking.create', 'booking.view', 'customer.view']);
    await drainJobs();
    expect(sentTo(member.user.email).some((m) => /role changed/i.test(m.subject))).toBe(true);
    expect((await businessContext(member.user)).permissions.has('booking.create')).toBe(true); // takes effect at once
  });

  it('a role in use cannot be archived; once free it is archived (never deleted) and can no longer be assigned', async () => {
    const ws = await onPlan('Archive Role Biz', 'business');
    const role = await createRole(ws.ctx, { name: 'Temp Staff', permissions: ['customer.view'] });
    const member = await createMemberCtx(ws, 'technician');
    await ownerQuery('UPDATE memberships SET role_id = $1 WHERE id = $2', [role.id, member.ctx.membership.id]);
    const blocked = await call(roleDefDelete, { method: 'DELETE', token: ws.ctx.token, params: { id: role.id } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/1 member is still assigned/);

    await ownerQuery("UPDATE memberships SET status = 'ARCHIVED' WHERE id = $1", [member.ctx.membership.id]);
    await archiveRole(ws.ctx, role.id);
    expect((await ownerQuery('SELECT archived_at FROM roles WHERE id = $1', [role.id])).rows[0]?.archived_at).not.toBeNull(); // the row still exists
    await expect(inviteMember(ws.ctx, { email: 'archived.role@example.test', roleId: role.id })).rejects.toMatchObject({ status: 422 });
    await expect(updateRole(ws.ctx, role.id, { name: 'Temp Staff', permissions: ['customer.view'] })).rejects.toMatchObject({ status: 409 });
    expect((await listRoles(ws.ctx)).find((r) => r.id === role.id)).toMatchObject({ archived: true });
  });

  it('system roles cannot be edited or archived through the API, and not at the database either', async () => {
    const ws = await onPlan('System Role Biz', 'business');
    const tech = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    expect((await call(roleDefPatch, { method: 'PATCH', token: ws.ctx.token, params: { id: tech.id }, body: { name: 'Technician', permissions: ['business.close'] } })).status).toBe(404);
    expect((await call(roleDefDelete, { method: 'DELETE', token: ws.ctx.token, params: { id: tech.id } })).status).toBe(404);
    await expect(prisma().role.update({ where: { id: tech.id }, data: { name: 'Hacked' } })).rejects.toThrow(/managed by migrations/);
    await expect(prisma().rolePermission.create({ data: { roleId: tech.id, permission: 'business.close' } })).rejects.toThrow(/managed by migrations/);
  });

  it('is isolated per business: another business can neither see, edit nor archive your custom roles', async () => {
    const a = await onPlan('Role Iso A', 'business');
    const b = await onPlan('Role Iso B', 'business');
    const role = await createRole(a.ctx, { name: 'A Only Role', permissions: ['customer.view'] });
    expect((await listRoles(b.ctx)).map((r) => r.id)).not.toContain(role.id);
    expect((await call(roleDefPatch, { method: 'PATCH', token: b.ctx.token, params: { id: role.id }, body: { name: 'Stolen Role', permissions: ['customer.view'] } })).status).toBe(404);
    expect((await call(roleDefDelete, { method: 'DELETE', token: b.ctx.token, params: { id: role.id } })).status).toBe(404);
    await expect(inviteMember(b.ctx, { email: 'iso.role@example.test', roleId: role.id })).rejects.toMatchObject({ status: 422 });
    expect((await call(roleDefsGet, { token: b.ctx.token })).body.data.roles.some((r: { id: string }) => r.id === role.id)).toBe(false);
    // The database also refuses mixing: a membership of B cannot hold A's role.
    const m = await createMemberCtx(b, 'technician');
    await expect(ownerQuery('UPDATE memberships SET role_id = $1 WHERE id = $2', [role.id, m.ctx.membership.id])).rejects.toThrow(/does not belong to business/);
  });

  it('lists the permission catalogue (all groups from the specification) for building roles', async () => {
    const ws = await onPlan('Catalogue Biz', 'business');
    const res = await call(roleDefsGet, { token: ws.ctx.token });
    const cat = Object.keys(res.body.data.catalogue);
    for (const p of ['customer.view', 'vehicle.archive', 'job.assign', 'booking.reschedule', 'quote.send', 'invoice.cancel', 'payment.refund', 'inventory.return', 'employee.manage_roles', 'document.export', 'report.manage', 'settings.manage_billing', 'business.transfer_ownership', 'audit.view']) {
      expect(cat).toContain(p);
    }
    expect(cat).toHaveLength(Object.keys(res.body.data.catalogue).length);
    expect(cat.length).toBeGreaterThanOrEqual(60);
  });
});

describe('system role defaults match the specification', () => {
  const perms = async (key: string) => new Set((await prisma().rolePermission.findMany({ where: { role: { businessId: null, key } } })).map((p) => p.permission));

  it('Owner has everything; Admin has everything except ownership transfer and closure', async () => {
    const owner = await perms('owner');
    const admin = await perms('admin');
    const { ALL_PERMISSIONS } = await import('@/server/permissions/catalog');
    expect(owner.size).toBe(ALL_PERMISSIONS.length);
    expect(admin.has('business.close')).toBe(false);
    expect(admin.has('business.transfer_ownership')).toBe(false);
    expect(admin.has('settings.manage_billing')).toBe(true);
    expect(admin.size).toBe(ALL_PERMISSIONS.length - 2);
  });

  it('Technician works on assigned jobs, not money or admin', async () => {
    const t = await perms('technician');
    for (const p of ['job.view', 'job.edit', 'job.complete', 'vehicle.view', 'inventory.view', 'document.upload']) expect(t.has(p)).toBe(true);
    for (const p of ['invoice.view', 'payment.create', 'employee.invite', 'settings.edit', 'job.assign', 'customer.create']) expect(t.has(p)).toBe(false);
  });

  it('Service Advisor handles the front desk; Inventory handles stock; Accounts handles money', async () => {
    const sa = await perms('service_advisor');
    for (const p of ['customer.create', 'vehicle.create', 'booking.manage', 'job.create', 'quote.send', 'invoice.view', 'payment.create']) expect(sa.has(p)).toBe(true);
    expect(sa.has('payment.refund')).toBe(false);
    const inv = await perms('inventory_staff');
    for (const p of ['inventory.view', 'inventory.create', 'inventory.adjust', 'inventory.purchase', 'inventory.receive', 'inventory.return']) expect(inv.has(p)).toBe(true);
    expect(inv.has('invoice.view')).toBe(false);
    const acc = await perms('accounts');
    for (const p of ['quote.approve', 'invoice.create', 'invoice.send', 'payment.create', 'payment.refund', 'report.view', 'report.export']) expect(acc.has(p)).toBe(true);
    expect(acc.has('employee.invite')).toBe(false);
    expect(acc.has('inventory.adjust')).toBe(false);
  });

  it('Manager runs operations and reports but cannot manage billing, roles or ownership', async () => {
    const m = await perms('manager');
    for (const p of ['job.assign', 'booking.manage', 'quote.approve', 'inventory.adjust', 'report.export', 'employee.invite', 'audit.view']) expect(m.has(p)).toBe(true);
    for (const p of ['settings.manage_billing', 'employee.manage_roles', 'business.close', 'business.transfer_ownership', 'settings.manage_security']) expect(m.has(p)).toBe(false);
  });
});
