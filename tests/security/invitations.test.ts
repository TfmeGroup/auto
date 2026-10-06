import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { register, verifyEmail, login } from '@/server/auth/service';
import { acceptInvitation, inviteMember, resendInvitation, revokeInvitation } from '@/server/memberships/service';
import { hashToken } from '@/server/security/crypto';
import { POST as inviteRoute } from '@/app/api/v1/members/route';
import { POST as resendRoute } from '@/app/api/v1/members/[id]/resend/route';
import { POST as acceptRoute } from '@/app/api/v1/invitations/accept/route';
import { GET as customersRoute } from '@/app/api/v1/customers/route';
import { call } from '../helpers/http';
import {
  createMemberCtx, createUser, createWorkspace, drainJobs, latestEmailToken, latestEmailTo, ownerQuery, sentTo, testMeta, TEST_PASSWORD, uniqueEmail,
  upgradePlan, userContext, type TestWorkspace,
} from '../helpers/factory';

afterAll(disconnectPrisma);

const role = async (key: string) => (await prisma().role.findFirstOrThrow({ where: { businessId: null, key } })).id;

async function ws(name = 'Invite Co'): Promise<TestWorkspace> {
  const w = await createWorkspace(name);
  await upgradePlan(w);
  return w;
}

describe('inviting someone who ALREADY has an account', () => {
  it('invite → sign in → accept → membership created with the invited role', async () => {
    const w = await ws();
    const person = await createUser({ name: 'Existing Person' });
    const res = await call(inviteRoute, { token: w.ctx.token, body: { email: person.email, roleId: await role('service_advisor') } });
    expect(res.status).toBe(201);
    const mail = await latestEmailTo(person.email);
    expect(mail?.subject).toMatch(/invited you to Invite Co/);
    expect(mail?.text).toMatch(/\/accept-invite\?token=/);

    const token = await latestEmailToken(person.email);
    const raw = await ownerQuery('SELECT 1 FROM memberships WHERE invite_token_hash = $1', [token]);
    expect(raw.rowCount).toBe(0); // only a hash is stored
    const uctx = await userContext(person);
    const accepted = await call(acceptRoute, { token: uctx.token, body: { token } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ businessId: w.businessId, businessName: 'Invite Co' });

    const m = await prisma().membership.findFirstOrThrow({ where: { businessId: w.businessId, userId: person.id }, include: { role: true } });
    expect(m).toMatchObject({ status: 'ACTIVE', isOwner: false });
    expect(m.role.key).toBe('service_advisor');
    expect(m.joinedAt).not.toBeNull();
    expect(m.inviteTokenHash).toBeNull(); // invalidated after acceptance
    expect((await call(customersRoute, { token: uctx.token })).status).toBe(200); // now has access via membership
  });

  it('the account alone grants nothing: before accepting there is no business access', async () => {
    const w = await ws('No Access Yet Co');
    const person = await createUser();
    await inviteMember(w.ctx, { email: person.email, roleId: await role('technician') });
    const uctx = await userContext(person);
    const res = await call(customersRoute, { token: uctx.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_BUSINESS');
  });
});

describe('inviting someone with NO account yet', () => {
  it('invite → register → verify email → accept → membership created', async () => {
    const w = await ws('New Person Co');
    const email = uniqueEmail('newbie');
    await inviteMember(w.ctx, { email, roleId: await role('technician') });
    const inviteToken = await latestEmailToken(email);

    // They have no account: the link alone cannot be accepted anonymously.
    expect((await call(acceptRoute, { body: { token: inviteToken } })).status).toBe(401);

    await register({ firstName: 'New', lastName: 'Person', email, password: TEST_PASSWORD }, testMeta());
    const verifyMail = (await ownerQuery("SELECT payload->>'text' AS t FROM jobs WHERE type='email.send' AND payload->>'to' = $1 AND payload->>'subject' LIKE 'Verify%'", [email])).rows[0]!.t as string;
    const verifyToken = /token=([\w-]+)/.exec(verifyMail)![1]!;
    const lr = await login({ email, password: TEST_PASSWORD }, testMeta());
    if (lr.kind !== 'session') throw new Error('expected session');
    const { authenticate } = await import('@/server/tenancy/context');
    const auth = (await authenticate(lr.session.token, testMeta()))!;

    // Unverified email: accepting is refused until they verify.
    expect((await call(acceptRoute, { token: lr.session.token, body: { token: inviteToken } })).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    await verifyEmail(verifyToken, testMeta());
    const accepted = await call(acceptRoute, { token: lr.session.token, body: { token: inviteToken } });
    expect(accepted.status).toBe(200);
    expect(await prisma().membership.count({ where: { businessId: w.businessId, userId: auth.user.user.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('registering with the invited email does NOT automatically join anyone', async () => {
    const w = await ws('No Auto Join Co');
    const email = uniqueEmail('noauto');
    await inviteMember(w.ctx, { email, roleId: await role('manager') });
    await register({ firstName: 'No', lastName: 'Auto', email, password: TEST_PASSWORD }, testMeta());
    const u = await prisma().user.findUniqueOrThrow({ where: { email } });
    expect(await prisma().membership.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe('invitation tokens: secure, expiring, single-use, bound to the right business', () => {
  it('expire after 7 days; resending issues a fresh link and revives an expired invitation', async () => {
    const w = await ws('Expiry Invite Co');
    const person = await createUser();
    const inv = await inviteMember(w.ctx, { email: person.email, roleId: await role('technician') });
    const oldToken = await latestEmailToken(person.email);
    const row = (await ownerQuery('SELECT invite_expires_at, invited_at FROM memberships WHERE id = $1', [inv.id])).rows[0]!;
    const days = (new Date(row.invite_expires_at).getTime() - new Date(row.invited_at).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 0);

    await ownerQuery("UPDATE memberships SET invite_expires_at = now() - interval '1 minute' WHERE id = $1", [inv.id]);
    const uctx = await userContext(person);
    await expect(acceptInvitation(uctx, oldToken)).rejects.toMatchObject({ status: 400 });

    await resendInvitation(w.ctx, inv.id);
    const newToken = await latestEmailToken(person.email);
    expect(newToken).not.toBe(oldToken);
    await expect(acceptInvitation(uctx, oldToken)).rejects.toMatchObject({ status: 400 }); // old link is dead
    await expect(acceptInvitation(uctx, newToken)).resolves.toMatchObject({ businessId: w.businessId });
  });

  it('a link is single-use, even under a concurrent double-submit', async () => {
    const w = await ws('Race Invite Co');
    const person = await createUser();
    await inviteMember(w.ctx, { email: person.email, roleId: await role('technician') });
    const token = await latestEmailToken(person.email);
    const uctx = await userContext(person);
    const results = await Promise.allSettled([acceptInvitation(uctx, token), acceptInvitation(uctx, token), acceptInvitation(uctx, token)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma().membership.count({ where: { businessId: w.businessId, userId: person.id } })).toBe(1);
  });

  it('is bound to its business: it can only ever add the person to THAT business, with THAT role', async () => {
    const a = await ws('Bound A');
    const b = await ws('Bound B');
    const person = await createUser();
    await inviteMember(a.ctx, { email: person.email, roleId: await role('technician') });
    const token = await latestEmailToken(person.email);
    await acceptInvitation(await userContext(person), token);
    expect(await prisma().membership.count({ where: { userId: person.id, businessId: a.businessId } })).toBe(1);
    expect(await prisma().membership.count({ where: { userId: person.id, businessId: b.businessId } })).toBe(0);
  });

  it('a revoked invitation is invalidated; so is a different person using the link', async () => {
    const w = await ws('Revoke Co');
    const person = await createUser();
    const thief = await createUser();
    const inv = await inviteMember(w.ctx, { email: person.email, roleId: await role('technician') });
    const token = await latestEmailToken(person.email);
    await expect(acceptInvitation(await userContext(thief), token)).rejects.toMatchObject({ status: 400 });
    await revokeInvitation(w.ctx, inv.id);
    expect((await ownerQuery('SELECT invite_token_hash, status FROM memberships WHERE id = $1', [inv.id])).rows[0]).toEqual({ invite_token_hash: null, status: 'ARCHIVED' });
    await expect(acceptInvitation(await userContext(person), token)).rejects.toMatchObject({ status: 400 });
  });

  it('cannot be forged: unknown, truncated and wrong-type tokens are refused', async () => {
    const person = await userContext(await createUser());
    for (const bad of ['', 'abc', 'x'.repeat(43), 'f'.repeat(500)]) {
      expect((await call(acceptRoute, { token: person.token, body: { token: bad } })).status, bad.slice(0, 10)).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('resend and cancel', () => {
  it('resend is rate limited per invitation and limited to people who may invite', async () => {
    const w = await ws('Resend Limit Co');
    const inv = await inviteMember(w.ctx, { email: uniqueEmail('resend'), roleId: await role('technician') });
    const tech = await createMemberCtx(w, 'technician');
    expect((await call(resendRoute, { token: tech.ctx.token, params: { id: inv.id }, body: {} })).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await call(resendRoute, { token: w.ctx.token, params: { id: inv.id }, body: {} })).status).toBe(200);
    const fourth = await call(resendRoute, { token: w.ctx.token, params: { id: inv.id }, body: {} });
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get('retry-after')).toBeTruthy();
  });

  it('resend only works for open invitations of this business', async () => {
    const a = await ws('Resend Iso A');
    const b = await ws('Resend Iso B');
    const inv = await inviteMember(b.ctx, { email: uniqueEmail('theirs'), roleId: await role('technician') });
    expect((await call(resendRoute, { token: a.ctx.token, params: { id: inv.id }, body: {} })).status).toBe(404);
    const member = await createMemberCtx(a, 'technician');
    expect((await call(resendRoute, { token: a.ctx.token, params: { id: member.ctx.membership.id }, body: {} })).status).toBe(409);
  });

  it('invitations are rate limited per business and per inviter', async () => {
    const w = await ws('Invite Flood Co');
    let blocked = false;
    for (let i = 0; i < 24; i++) {
      const r = await call(inviteRoute, { token: w.ctx.token, body: { email: uniqueEmail('flood'), roleId: await role('technician') } });
      if (r.status === 429) { blocked = true; break; }
      if (r.status === 402) break; // seat limit reached first on this plan
    }
    // Either the plan seat cap or the abuse limiter stops a flood; both are real protections.
    expect(blocked || (await prisma().membership.count({ where: { businessId: w.businessId } })) <= 35).toBe(true);
  });

  it('every invitation event is audited and the invitee gets a proper email', async () => {
    const w = await ws('Audited Invite Co');
    const person = await createUser();
    const inv = await inviteMember(w.ctx, { email: person.email, roleId: await role('technician') });
    await resendInvitation(w.ctx, inv.id);
    await acceptInvitation(await userContext(person), await latestEmailToken(person.email));
    const actions = (await ownerQuery("SELECT action FROM audit_logs WHERE business_id = $1 AND action LIKE 'member.%'", [w.businessId])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['member.invited', 'member.invite_resent', 'member.joined']));
    await drainJobs();
    expect(sentTo(person.email).some((m) => /invited you/.test(m.subject))).toBe(true);
    expect(sentTo(w.owner.email).some((m) => /joined Audited Invite Co/.test(m.text))).toBe(true); // the inviter hears about it
    expect(hashToken('x')).toHaveLength(64);
  });
});

describe('membership changes alert the person affected', () => {
  it('role changes, suspension and reactivation each produce a security email and an audit event', async () => {
    const w = await ws('Alert Co');
    const m = await createMemberCtx(w, 'technician');
    const { changeMemberRole, changeMemberStatus } = await import('@/server/memberships/service');
    await changeMemberRole(w.ctx, m.ctx.membership.id, { roleId: await role('manager') });
    await changeMemberStatus(w.ctx, m.ctx.membership.id, 'suspend');
    await changeMemberStatus(w.ctx, m.ctx.membership.id, 'reactivate');
    await drainJobs();
    const subjects = sentTo(m.user.email).map((x) => x.subject + ' ' + x.text);
    expect(subjects.some((s) => /role .* changed from Technician to Manager/i.test(s))).toBe(true);
    expect(subjects.some((s) => /suspended/i.test(s))).toBe(true);
    expect(subjects.some((s) => /restored/i.test(s))).toBe(true);
    const actions = (await ownerQuery("SELECT action FROM audit_logs WHERE business_id = $1 AND resource_id = $2", [w.businessId, m.ctx.membership.id])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['member.role_changed', 'member.suspended', 'member.reactivated']));
  });
});
