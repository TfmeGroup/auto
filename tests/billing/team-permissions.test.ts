import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { changeMemberRole } from '@/server/memberships/service';
import { GET as rolesGet } from '@/app/api/v1/roles/route';
import { GET as roleDefsGet, POST as roleDefsPost } from '@/app/api/v1/role-definitions/route';
import { PATCH as roleDefPatch } from '@/app/api/v1/role-definitions/[id]/route';
import { GET as customersGet, POST as customersPost } from '@/app/api/v1/customers/route';
import { GET as invoicesGet } from '@/app/api/v1/invoices/route';
import { POST as inviteRoute } from '@/app/api/v1/members/route';
import { call } from '../helpers/http';
import { customerInput } from '../helpers/customers';
import { businessContext, createMemberCtx, createWorkspace, ownerQuery, uniqueEmail } from '../helpers/factory';

afterAll(disconnectPrisma);

async function teamWorkspace() {
  const ws = await createWorkspace('Team Perms Co');
  await ownerQuery(`UPDATE subscriptions SET status='ACTIVE', trial_ends_at=NULL, current_period_end=now()+interval '30 days', plan_id=(SELECT id FROM plans WHERE key='team') WHERE business_id=$1`, [ws.businessId]);
  ws.ctx = await businessContext(ws.owner);
  return ws;
}

describe('Team: granular permissions through the predefined roles; custom roles stay Business-only', () => {
  it('the Team plan has no custom-role entitlement, and nothing else about permissions is gated', async () => {
    const ws = await teamWorkspace();
    expect(ws.ctx.subscription.planKey).toBe('team');
    expect(ws.ctx.subscription.features.has('custom_roles')).toBe(false);
    expect(ws.ctx.subscription.features.has('mfa_enforcement')).toBe(true);
    expect(ws.ctx.subscription.features.has('technician_management')).toBe(true);
  });

  it('can see the predefined roles and their permissions, and assign them to people', async () => {
    const ws = await teamWorkspace();
    const roles = await call(rolesGet, { token: ws.ctx.token });
    expect(roles.status).toBe(200);
    const keys = roles.body.data.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['admin', 'manager', 'technician', 'service_advisor', 'accounts']));
    const defs = await call(roleDefsGet, { token: ws.ctx.token });
    expect(defs.status).toBe(200);
    expect(Object.keys(defs.body.data.catalogue ?? {}).length + (Array.isArray(defs.body.data.catalogue) ? defs.body.data.catalogue.length : 0)).toBeGreaterThan(0); // the permission catalogue is visible on Team
    const technician = defs.body.data.roles.find((r: { key: string }) => r.key === 'technician');
    expect(technician.permissions.length).toBeGreaterThan(0);

    const tech = await createMemberCtx(ws, 'technician');
    const advisorRole = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'service_advisor' } });
    await changeMemberRole(ws.ctx, tech.ctx.membership.id, { roleId: advisorRole.id });
    const after = (await ownerQuery<{ key: string }>('SELECT r.key FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.id = $1', [tech.ctx.membership.id])).rows[0]!;
    expect(after.key).toBe('service_advisor');
    const invite = await call(inviteRoute, { method: 'POST', token: ws.ctx.token, body: { email: uniqueEmail('teamperm'), roleId: advisorRole.id } });
    expect(invite.status).toBeLessThan(300);
  });

  it('predefined roles enforce different permissions on the server', async () => {
    const ws = await teamWorkspace();
    const tech = await createMemberCtx(ws, 'technician');
    const advisor = await createMemberCtx(ws, 'service_advisor');
    const accounts = await createMemberCtx(ws, 'accounts');
    expect((await call(customersPost, { method: 'POST', token: tech.ctx.token, body: customerInput('By technician') })).status).toBe(403);
    expect((await call(customersPost, { method: 'POST', token: advisor.ctx.token, body: customerInput('By advisor') })).status).toBe(201);
    expect((await call(customersPost, { method: 'POST', token: accounts.ctx.token, body: customerInput('By accounts') })).status).toBe(403);
    expect((await call(invoicesGet, { token: accounts.ctx.token })).status).toBe(200);
    expect((await call(invoicesGet, { token: tech.ctx.token })).status).toBe(403);
    expect((await call(customersGet, { token: tech.ctx.token })).status).toBe(200);
    // and the people who may not manage roles cannot assign them
    const adminRole = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'admin' } });
    expect((await call(inviteRoute, { method: 'POST', token: advisor.ctx.token, body: { email: uniqueEmail('nope'), roleId: adminRole.id } })).status).toBe(403);
  });

  it('creating or editing a custom role is refused on Team with a 402 naming the feature, and creates nothing', async () => {
    const ws = await teamWorkspace();
    const create = await call(roleDefsPost, { method: 'POST', token: ws.ctx.token, body: { name: 'Bay Lead', permissions: ['job.view'] } });
    expect(create.status).toBe(402);
    expect(create.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(await prisma().role.count({ where: { businessId: ws.businessId } })).toBe(0);
    const edit = await call(roleDefPatch, { method: 'PATCH', token: ws.ctx.token, params: { id: '00000000-0000-4000-8000-000000000000' }, body: { name: 'x' } });
    expect(edit.status).toBe(402);
  });

  it('the same business can create a custom role once it is on Business', async () => {
    const ws = await teamWorkspace();
    await ownerQuery(`UPDATE subscriptions SET plan_id=(SELECT id FROM plans WHERE key='business') WHERE business_id=$1`, [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);
    const create = await call(roleDefsPost, { method: 'POST', token: ws.ctx.token, body: { name: 'Bay Lead', permissions: ['job.view'] } });
    expect(create.status).toBeLessThan(300);
  });
});
