import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { GET as listRoute } from '@/app/api/platform/businesses/route';
import { POST as customPlanRoute } from '@/app/api/platform/businesses/[id]/custom-plan/route';
import { GET as customersRoute } from '@/app/api/v1/customers/route';
import { call } from '../helpers/http';
import { enableMfaFor } from '../helpers/mfa';
import { businessContext, createUser, createWorkspace, ownerQuery, userContext } from '../helpers/factory';

afterAll(disconnectPrisma);

async function platformAdmin(withMfa = true) {
  const user = await createUser({ name: 'Platform Person' });
  await ownerQuery('INSERT INTO platform_admins (user_id) VALUES ($1)', [user.id]); // only owner-level tooling can do this
  if (withMfa) await enableMfaFor(user);
  return { user, token: (await userContext(user)).token };
}

const contract = (over: Record<string, unknown> = {}) => ({
  maxMembers: 80, maxLocations: 12, maxStorageMb: 200_000, contractEndsAt: new Date(Date.now() + 365 * 86_400_000).toISOString(), note: 'Fleet contract', ...over,
});

describe('platform administration is separate from business administration', () => {
  it('a business OWNER (the most powerful business role) has no access to platform endpoints, and is told nothing about them', async () => {
    const ws = await createWorkspace('Powerful Owner Co');
    const list = await call(listRoute, { token: ws.ctx.token });
    expect(list.status).toBe(404);
    const assign = await call(customPlanRoute, { token: ws.ctx.token, params: { id: ws.businessId }, body: contract() });
    expect(assign.status).toBe(404);
    // …and it truly did nothing.
    expect((await prisma().subscription.findUniqueOrThrow({ where: { businessId: ws.businessId } })).overrideMaxMembers).toBeNull();
  });

  it('no business permission or role can reach it — not even all permissions at once', async () => {
    const ws = await createWorkspace('All Perms Co');
    const ctx = await businessContext(ws.owner);
    expect(ctx.permissions.size).toBeGreaterThan(50);
    expect((await call(listRoute, { token: ctx.token })).status).toBe(404);
  });

  it('unauthenticated callers are refused', async () => {
    expect((await call(listRoute, {})).status).toBe(401);
    expect((await call(customPlanRoute, { params: { id: '00000000-0000-4000-8000-000000000000' }, body: contract() })).status).toBe(401);
  });

  it('platform admins must have two-factor authentication on', async () => {
    const noMfa = await platformAdmin(false);
    const res = await call(listRoute, { token: noMfa.token });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/two-factor/i);
  });

  it('a platform admin can list businesses (basic facts only, no member data)', async () => {
    const ws = await createWorkspace('Listed Biz Co');
    const admin = await platformAdmin();
    const res = await call(listRoute, { token: admin.token, query: { q: 'Listed Biz' } });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual(expect.objectContaining({ id: ws.businessId, name: 'Listed Biz Co', plan: 'trial', subscriptionStatus: 'TRIALING' }));
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(ws.owner.email));
  });

  it('being a platform admin does NOT grant access to any business’s data', async () => {
    await createWorkspace('Walled Garden Co');
    const admin = await platformAdmin();
    const res = await call(customersRoute, { token: admin.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_BUSINESS');
  });

  it('assigns a CUSTOM (36+ users) contract: overrides apply, every feature is on, and it is audited against the business', async () => {
    const ws = await createWorkspace('Contract Co');
    const admin = await platformAdmin();
    const res = await call(customPlanRoute, { token: admin.token, params: { id: ws.businessId }, body: contract() });
    expect(res.status).toBe(200);

    const sub = await prisma().subscription.findUniqueOrThrow({ where: { businessId: ws.businessId }, include: { plan: true } });
    expect(sub).toMatchObject({ status: 'ACTIVE', overrideMaxMembers: 80, overrideMaxLocations: 12, overrideMaxStorageMb: 200_000, provider: null });
    expect(sub.plan.key).toBe('custom');
    expect(sub.convertedAt).not.toBeNull();

    const ctx = await businessContext(ws.owner);
    expect(ctx.subscription).toMatchObject({ planKey: 'custom', isCustom: true, canWrite: true });
    expect(ctx.subscription.limits).toMatchObject({ members: 80, locations: 12, storageMb: 200_000 });
    expect(ctx.subscription.features.has('custom_roles')).toBe(true);

    const audit = await ownerQuery("SELECT user_id, after FROM audit_logs WHERE business_id = $1 AND action = 'platform.custom_plan_assigned'", [ws.businessId]);
    expect(audit.rows[0]).toMatchObject({ user_id: admin.user.id });
    expect(audit.rows[0]?.after.maxMembers).toBe(80);
  });

  it('custom plans start at 36 users and need a future end date', async () => {
    const ws = await createWorkspace('Small Contract Co');
    const admin = await platformAdmin();
    expect((await call(customPlanRoute, { token: admin.token, params: { id: ws.businessId }, body: contract({ maxMembers: 20 }) })).status).toBe(422);
    expect((await call(customPlanRoute, { token: admin.token, params: { id: ws.businessId }, body: contract({ contractEndsAt: '2020-01-01' }) })).status).toBe(422);
    expect((await call(customPlanRoute, { token: admin.token, params: { id: '00000000-0000-4000-8000-000000000000' }, body: contract() })).status).toBe(404);
    expect((await call(customPlanRoute, { token: admin.token, params: { id: 'nope' }, body: contract() })).status).toBe(422);
  });

  it('the app cannot grant itself platform-admin: the table is owner-managed', async () => {
    const u = await createUser();
    await expect(prisma().platformAdmin.create({ data: { userId: u.id } })).rejects.toThrow(/permission denied/i);
  });
});
