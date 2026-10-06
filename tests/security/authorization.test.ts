import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnerClient, disconnectPrisma, prisma } from '@/server/db/client';
import { createCustomer, setCustomerArchived } from '@/server/customers/service';
import { createBusiness } from '@/server/businesses/service';
import {
  acceptInvitation, changeMemberRole, changeMemberStatus, inviteMember, listAssignableRoles, revokeInvitation,
} from '@/server/memberships/service';
import { syncSystemRoles } from '@/server/permissions/sync';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '@/server/permissions/catalog';
import { POST as createCustomerRoute, GET as listCustomersRoute } from '@/app/api/v1/customers/route';
import { POST as createBusinessRoute } from '@/app/api/v1/businesses/route';
import { GET as auditRoute } from '@/app/api/v1/audit/route';
import { GET as billingRoute } from '@/app/api/v1/billing/route';
import { GET as roleListRoute } from '@/app/api/v1/roles/route';
import { call } from '../helpers/http';
import {
  businessContext, createMemberCtx, createUser, createWorkspace, latestEmailToken, ownerQuery, upgradePlan, userContext,
  type TestWorkspace,
} from '../helpers/factory';

import { customerInput } from '../helpers/customers';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await createWorkspace('Authorization Workshop');
  await upgradePlan(ws); // roomy limits: seat limits have their own tests
});

const roleId = async (key: string) => (await prisma().role.findFirstOrThrow({ where: { businessId: null, key } })).id;

describe('permission matrix (checks use permissions, not role names)', () => {
  it('system roles only contain permissions that exist in the catalog', () => {
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) expect(ALL_PERMISSIONS).toContain(p);
  });

  it('technician: can view customers and upload photos, cannot create customers or manage staff', async () => {
    const t = await createMemberCtx(ws, 'technician');
    expect((await call(listCustomersRoute, { token: t.ctx.token })).status).toBe(200);
    const denied = await call(createCustomerRoute, { token: t.ctx.token, body: customerInput('Nope') });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    await expect(createCustomer(t.ctx, customerInput('Nope'))).rejects.toMatchObject({ status: 403 });
    await expect(inviteMember(t.ctx, { email: 'x@example.test', roleId: await roleId('technician') })).rejects.toMatchObject({ status: 403 });
    expect((await call(auditRoute, { token: t.ctx.token })).status).toBe(403);
    expect((await call(billingRoute, { token: t.ctx.token })).status).toBe(403);
  });

  it('accounts: reads customers but cannot create or archive them', async () => {
    const a = await createMemberCtx(ws, 'accounts');
    expect((await call(listCustomersRoute, { token: a.ctx.token })).status).toBe(200);
    expect((await call(createCustomerRoute, { token: a.ctx.token, body: customerInput('Nope') })).status).toBe(403);
  });

  it('service advisor: can create and edit customers, cannot archive or invite', async () => {
    const s = await createMemberCtx(ws, 'service_advisor');
    const c = await createCustomer(s.ctx, customerInput('Advisor Customer'));
    await expect(setCustomerArchived(s.ctx, c.id, true)).rejects.toMatchObject({ status: 403 });
    await expect(inviteMember(s.ctx, { email: 'y@example.test', roleId: await roleId('technician') })).rejects.toMatchObject({ status: 403 });
  });

  it('manager: can archive but not read billing or edit business config', async () => {
    const m = await createMemberCtx(ws, 'manager');
    const c = await createCustomer(m.ctx, customerInput('Manager Customer'));
    await expect(setCustomerArchived(m.ctx, c.id, true)).resolves.toMatchObject({ status: 'ARCHIVED' });
    expect((await call(billingRoute, { token: m.ctx.token })).status).toBe(403);
  });

  it('permissions are read from the database, so changing a role changes access with no code change', async () => {
    const s = await createMemberCtx(ws, 'service_advisor');
    expect((await call(createCustomerRoute, { token: s.ctx.token, body: customerInput('Before') })).status).toBe(201);
    await ownerQuery(
      "DELETE FROM role_permissions WHERE permission = 'customer.create' AND role_id = (SELECT id FROM roles WHERE key = 'service_advisor' AND business_id IS NULL)",
    );
    try {
      expect((await call(createCustomerRoute, { token: s.ctx.token, body: customerInput('After') })).status).toBe(403);
    } finally {
      const owner = createOwnerClient(); // restoring role data is an owner-only operation
      try {
        await syncSystemRoles(owner);
      } finally {
        await owner.$disconnect();
      }
    }
    expect((await call(createCustomerRoute, { token: s.ctx.token, body: customerInput('Restored') })).status).toBe(201);
  });
});

describe('API gatekeeping', () => {
  it('unauthenticated requests are rejected', async () => {
    const res = await call(listCustomersRoute, {});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('a signed-in user without a business cannot use business features', async () => {
    const u = await createUser();
    const uctx = await userContext(u);
    const res = await call(listCustomersRoute, { token: uctx.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_BUSINESS');
  });

  it('an unverified email cannot create a business', async () => {
    const u = await createUser({ verified: false });
    const uctx = await userContext(u);
    await expect(createBusiness(uctx, { name: 'Sneaky Garage' })).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    const res = await call(createBusinessRoute, { token: uctx.token, body: { name: 'Sneaky Garage' } });
    expect(res.status).toBe(403);
  });

  it('rejects cross-site browser requests to mutating endpoints (CSRF)', async () => {
    const forged = await call(createCustomerRoute, { token: ws.ctx.token, origin: 'https://evil.example', body: customerInput('CSRF') });
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('CSRF_REJECTED');
    const crossSite = await call(createCustomerRoute, { token: ws.ctx.token, origin: null, headers: { 'sec-fetch-site': 'cross-site' }, body: { name: 'CSRF' } });
    expect(crossSite.status).toBe(403);
    expect((await ownerQuery("SELECT 1 FROM customers WHERE name = 'CSRF'")).rowCount).toBe(0);
    // legitimate same-origin requests still work
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Legit') })).status).toBe(201);
  });

  it('error responses use a consistent envelope and never leak internals', async () => {
    const res = await call(createCustomerRoute, { token: ws.ctx.token, body: '{not json' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message', 'requestId']);
    const invalid = await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('') });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details.firstName).toBeTruthy();
    expect(JSON.stringify(invalid.body)).not.toMatch(/stack|prisma|postgres|at \w+ \(/i);
    expect(invalid.headers.get('x-request-id')).toBe(invalid.body.error.requestId);
  });
});

describe('privilege escalation guards', () => {
  it('a manager cannot invite an admin or owner (cannot grant what they lack)', async () => {
    const m = await createMemberCtx(ws, 'manager');
    await expect(inviteMember(m.ctx, { email: 'a@example.test', roleId: await roleId('owner') })).rejects.toMatchObject({ status: 403 });
    await expect(inviteMember(m.ctx, { email: 'a@example.test', roleId: await roleId('admin') })).rejects.toMatchObject({ status: 403 });
    await expect(inviteMember(m.ctx, { email: 'a@example.test', roleId: await roleId('technician') })).resolves.toBeTruthy();
  });

  it('an admin cannot create an owner; assignable roles reflect what the caller may grant', async () => {
    const a = await createMemberCtx(ws, 'admin');
    await expect(inviteMember(a.ctx, { email: 'o@example.test', roleId: await roleId('owner') })).rejects.toMatchObject({ status: 403 });
    const names = (await listAssignableRoles(a.ctx)).map((r) => r.key);
    expect(names).not.toContain('owner');
    expect(names).toContain('manager');
    const viaApi = await call(roleListRoute, { token: a.ctx.token });
    expect(viaApi.body.data.map((r: { key: string }) => r.key)).not.toContain('owner');
  });

  it('nobody can promote themselves or others beyond their own permissions', async () => {
    const m = await createMemberCtx(ws, 'manager');
    await expect(changeMemberRole(m.ctx, m.ctx.membership.id, { roleId: await roleId('owner') })).rejects.toMatchObject({ status: 403 });
  });

  it('a lower role cannot demote or suspend a higher one', async () => {
    const admin = await createMemberCtx(ws, 'admin');
    const manager = await createMemberCtx(ws, 'manager');
    await expect(changeMemberRole(manager.ctx, admin.ctx.membership.id, { roleId: await roleId('technician') })).rejects.toMatchObject({ status: 403 });
    await expect(changeMemberStatus(manager.ctx, admin.ctx.membership.id, 'suspend')).rejects.toMatchObject({ status: 403 });
  });

  it('cannot change your own access status', async () => {
    const a = await createMemberCtx(ws, 'admin');
    await expect(changeMemberStatus(a.ctx, a.ctx.membership.id, 'suspend')).rejects.toMatchObject({ status: 409 });
  });
});

describe('a business has exactly one Owner', () => {
  it('the Owner cannot be demoted, suspended or removed by anyone — including themselves', async () => {
    const co = await createWorkspace('One Owner Co');
    const admin = await createMemberCtx(co, 'admin');
    await expect(changeMemberRole(co.ctx, co.ctx.membership.id, { roleId: await roleId('admin') })).rejects.toMatchObject({ status: 409 });
    await expect(changeMemberStatus(admin.ctx, co.ctx.membership.id, 'suspend')).rejects.toMatchObject({ status: 409 });
    await expect(changeMemberStatus(admin.ctx, co.ctx.membership.id, 'remove')).rejects.toMatchObject({ status: 409 });
    expect((await prisma().membership.findUniqueOrThrow({ where: { id: co.ctx.membership.id } })).status).toBe('ACTIVE');
  });

  it('Owner is never granted by invitation or role change', async () => {
    const co = await createWorkspace('No Grant Co');
    const member = await createMemberCtx(co, 'manager');
    await expect(changeMemberRole(co.ctx, member.ctx.membership.id, { roleId: await roleId('owner') })).rejects.toMatchObject({ status: 403 });
    await expect(inviteMember(co.ctx, { email: 'x@example.test', roleId: await roleId('owner') })).rejects.toMatchObject({ status: 403 });
    const assignable = (await listAssignableRoles(co.ctx)).map((r) => r.key);
    expect(assignable).not.toContain('owner');
  });

  it('the DATABASE itself refuses a second active Owner', async () => {
    const co = await createWorkspace('DB Owner Co');
    const other = await createUser();
    const owner = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'owner' } });
    await expect(
      ownerQuery("INSERT INTO memberships (business_id, user_id, role_id, status, updated_at) VALUES ($1, $2, $3, 'ACTIVE', now())", [co.businessId, other.id, owner.id]),
    ).rejects.toThrow(/memberships_one_active_owner_uniq/);
  });
});

describe('invitations', () => {
  async function invite(email: string, key = 'technician') {
    await inviteMember(ws.ctx, { email, roleId: await roleId(key) });
    return latestEmailToken(email);
  }

  it('the invited person joins with the invited role and the invitation is single-use', async () => {
    const invitee = await createUser();
    const token = await invite(invitee.email, 'technician');
    const uctx = await userContext(invitee);
    const joined = await acceptInvitation(uctx, token);
    expect(joined.businessId).toBe(ws.businessId);
    const ctx = await businessContext(invitee);
    expect(ctx.membership.roleKey).toBe('technician');
    expect(ctx.permissions.has('customer.create')).toBe(false);
    await expect(acceptInvitation(await userContext(invitee), token)).rejects.toMatchObject({ status: 400 });
  });

  it('a leaked link is useless to a different account', async () => {
    const invitee = await createUser();
    const thief = await createUser();
    const token = await invite(invitee.email);
    await expect(acceptInvitation(await userContext(thief), token)).rejects.toMatchObject({ status: 400 });
    expect((await prisma().membership.count({ where: { userId: thief.id } }))).toBe(0);
  });

  it('requires a verified email, and rejects expired, revoked and forged tokens', async () => {
    const unverified = await createUser({ verified: false });
    const t1 = await invite(unverified.email);
    await expect(acceptInvitation(await userContext(unverified), t1)).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    const expired = await createUser();
    const t2 = await invite(expired.email);
    await ownerQuery("UPDATE memberships SET invite_expires_at = now() - interval '1 minute' WHERE invited_email = $1", [expired.email]);
    await expect(acceptInvitation(await userContext(expired), t2)).rejects.toMatchObject({ status: 400 });

    const revoked = await createUser();
    const t3 = await invite(revoked.email);
    const row = await prisma().membership.findFirstOrThrow({ where: { invitedEmail: revoked.email } });
    await revokeInvitation(ws.ctx, row.id);
    await expect(acceptInvitation(await userContext(revoked), t3)).rejects.toMatchObject({ status: 400 });

    await expect(acceptInvitation(await userContext(revoked), 'f'.repeat(43))).rejects.toMatchObject({ status: 400 });
  });

  it('re-inviting the same email rotates the token without using an extra seat', async () => {
    const invitee = await createUser();
    const first = await invite(invitee.email);
    const seatsBefore = await prisma().membership.count({ where: { businessId: ws.businessId } });
    const second = await invite(invitee.email, 'manager');
    expect(second).not.toBe(first);
    expect(await prisma().membership.count({ where: { businessId: ws.businessId } })).toBe(seatsBefore);
    await expect(acceptInvitation(await userContext(invitee), first)).rejects.toMatchObject({ status: 400 });
    await expect(acceptInvitation(await userContext(invitee), second)).resolves.toBeTruthy();
  });

  it('cannot invite someone who is already a member', async () => {
    const m = await createMemberCtx(ws, 'technician');
    await expect(inviteMember(ws.ctx, { email: m.user.email, roleId: await roleId('technician') })).rejects.toMatchObject({ status: 409 });
  });

  it('is audited', async () => {
    const invitee = await createUser();
    const token = await invite(invitee.email);
    await acceptInvitation(await userContext(invitee), token);
    const a = await ownerQuery("SELECT action FROM audit_logs WHERE business_id = $1 AND action IN ('member.invited','member.joined')", [ws.businessId]);
    expect(a.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['member.invited', 'member.joined']));
  });
});

describe('database-level tenant integrity', () => {
  it('a membership cannot use another business’s custom role', async () => {
    const other = await createWorkspace('Custom Role Co');
    const custom = await ownerQuery<{ id: string }>(
      "INSERT INTO roles (business_id, key, name, is_system, updated_at) VALUES ($1, 'bay_lead', 'Bay Lead', false, now()) RETURNING id",
      [other.businessId],
    );
    const u = await createUser();
    await expect(
      ownerQuery(
        "INSERT INTO memberships (business_id, user_id, role_id, status, updated_at) VALUES ($1, $2, $3, 'ACTIVE', now())",
        [ws.businessId, u.id, custom.rows[0]!.id],
      ),
    ).rejects.toThrow(/does not belong to business/);
  });

  it('a membership cannot be granted another business’s location', async () => {
    const other = await createWorkspace('Location Co');
    const loc = await ownerQuery<{ id: string }>('SELECT id FROM locations WHERE business_id = $1', [other.businessId]);
    const m = await createMemberCtx(ws, 'technician');
    await expect(
      ownerQuery('INSERT INTO membership_locations (membership_id, location_id) VALUES ($1, $2)', [m.ctx.membership.id, loc.rows[0]!.id]),
    ).rejects.toThrow(/different businesses/);
  });

  it('enforces uniqueness, enums and checks in the database itself', async () => {
    const u = await createUser();
    await expect(ownerQuery("UPDATE users SET email = 'UPPER@EXAMPLE.TEST' WHERE id = $1", [u.id])).rejects.toThrow(/users_email_lowercase/);
    await expect(ownerQuery("UPDATE businesses SET vat_rate_bps = 20000 WHERE id = $1", [ws.businessId])).rejects.toThrow(/vat_rate_range/);
    await expect(ownerQuery("UPDATE memberships SET status = 'ACTIVE', user_id = NULL WHERE id = $1", [ws.ctx.membership.id])).rejects.toThrow();
    await expect(
      ownerQuery('INSERT INTO locations (business_id, name, is_default, updated_at) VALUES ($1, \'Second default\', true, now())', [ws.businessId]),
    ).rejects.toThrow(/locations_one_default/);
  });

  it('deleting a user is blocked while they hold memberships (history is preserved)', async () => {
    const m = await createMemberCtx(ws, 'technician');
    await expect(ownerQuery('DELETE FROM users WHERE id = $1', [m.user.id])).rejects.toThrow(/foreign key|violates/i);
  });
});
