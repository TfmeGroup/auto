import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { authenticate } from '@/server/tenancy/context';
import { login } from '@/server/auth/service';
import { hashToken } from '@/server/security/crypto';
import {
  confirmEmailChange, deactivateAccount, getNotificationSettings, listMySecurityEvents, listSessions, removeProfilePhoto, requestEmailChange,
  revokeOtherSessions, revokeOwnSession, setNotificationPreferences, setProfilePhoto, updateProfile, openOwnPhoto,
} from '@/server/account/service';
import { emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { GET as sessionsRoute } from '@/app/api/v1/account/sessions/route';
import { DELETE as revokeRoute } from '@/app/api/v1/account/sessions/[id]/route';
import { GET as accountRoute } from '@/app/api/v1/account/route';
import { POST as emailRoute } from '@/app/api/v1/account/email/route';
import { call } from '../helpers/http';
import {
  createMemberCtx, createUser, createWorkspace, emailCountTo, latestEmailTo, latestEmailToken, ownerQuery, testMeta, TEST_PASSWORD, uniqueEmail, userContext,
} from '../helpers/factory';

afterAll(disconnectPrisma);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe('profile', () => {
  it('edits first name, last name and mobile; the display name follows; the change is audited with before/after', async () => {
    const u = await createUser({ name: 'Old Name' });
    const ctx = await userContext(u);
    const out = await updateProfile(ctx, { firstName: 'Nomsa', lastName: 'Dube', mobile: '+27 82 555 0100' });
    expect(out).toMatchObject({ name: 'Nomsa Dube', mobile: '+27 82 555 0100' });
    const row = await ownerQuery("SELECT before, after FROM audit_logs WHERE user_id = $1 AND action = 'account.profile_updated'", [u.id]);
    expect(row.rows[0]?.before.firstName).toBe('Old');
    expect(row.rows[0]?.after.firstName).toBe('Nomsa');
    await expect(updateProfile(ctx, { firstName: '', lastName: 'X' })).rejects.toMatchObject({ status: 422 });
    await expect(updateProfile(ctx, { firstName: 'A', lastName: 'B', mobile: 'call me' })).rejects.toMatchObject({ status: 422 });
  });

  it('the account endpoint exposes the profile and nothing secret', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    const res = await call(accountRoute, { token: ctx.token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: u.email, emailVerified: true, status: 'ACTIVE' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|\$argon2|mfaSecret|tokenHash/i);
  });

  it('works with no business at all (a personal account is independent)', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    expect((await call(accountRoute, { token: ctx.token })).status).toBe(200);
    expect((await listSessions(ctx)).length).toBe(1);
  });
});

describe('profile photo', () => {
  it('stores a real image privately, serves only the owner their own, and replaces/removes cleanly', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    await setProfilePhoto(ctx, PNG, 'me.png');
    const key = (await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).profilePhotoKey!;
    expect(key.startsWith(`${u.id}/avatar/`)).toBe(true);
    const { size } = await openOwnPhoto(u.id);
    expect(size).toBe(PNG.length);

    await setProfilePhoto(ctx, Buffer.concat([PNG, Buffer.from([9])]), 'new.png');
    expect((await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).profilePhotoKey).not.toBe(key);

    await removeProfilePhoto(ctx);
    await expect(openOwnPhoto(u.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects SVG, scripts, empty and oversized files', async () => {
    const ctx = await userContext(await createUser());
    await expect(setProfilePhoto(ctx, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.svg')).rejects.toMatchObject({ status: 415 });
    await expect(setProfilePhoto(ctx, Buffer.from('<script>alert(1)</script>'), 'x.png')).rejects.toMatchObject({ status: 415 });
    await expect(setProfilePhoto(ctx, Buffer.alloc(0), 'x.png')).rejects.toMatchObject({ status: 422 });
    await expect(setProfilePhoto(ctx, Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'big.png')).rejects.toMatchObject({ status: 413 });
    await expect(setProfilePhoto(ctx, Buffer.from('%PDF-1.7 fake'), 'x.pdf')).rejects.toMatchObject({ status: 415 }); // images only
  });
});

describe('email change (a replacement address is never trusted until verified)', () => {
  it('keeps the old address in force until the link is opened, then switches, verifies and signs everyone out', async () => {
    const u = await createUser({ name: 'Mover Person' });
    const ctx = await userContext(u);
    const other = await userContext(u);
    const newEmail = uniqueEmail('moved');

    await requestEmailChange(ctx, { newEmail, password: TEST_PASSWORD });
    expect((await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(u.email); // unchanged
    expect((await latestEmailTo(newEmail))?.subject).toMatch(/confirm/i);
    expect((await latestEmailTo(u.email))?.subject).toMatch(/change of email address was requested/i); // old address is warned

    const token = await latestEmailToken(newEmail);
    const raw = await ownerQuery('SELECT 1 FROM auth_tokens WHERE token_hash = $1', [token]);
    expect(raw.rowCount).toBe(0); // only a hash is stored
    await confirmEmailChange(token, testMeta());

    const after = await prisma().user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.email).toBe(newEmail);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await authenticate(ctx.token, testMeta())).toBeNull();
    expect(await authenticate(other.token, testMeta())).toBeNull();
    expect((await latestEmailTo(u.email))?.subject).toMatch(/was changed/i); // old address told it happened
    await expect(login({ email: u.email, password: TEST_PASSWORD }, testMeta())).rejects.toMatchObject({ status: 401 });
    await expect(login({ email: newEmail, password: TEST_PASSWORD }, testMeta())).resolves.toBeTruthy();
    const events = await ownerQuery("SELECT action FROM audit_logs WHERE user_id = $1 AND action LIKE 'account.email%'", [u.id]);
    expect(events.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['account.email_change_requested', 'account.email_changed']));
  });

  it('needs the correct password, rejects the same address, and the link is single-use and expires', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    await expect(requestEmailChange(ctx, { newEmail: uniqueEmail(), password: 'Wrong-Password-1!' })).rejects.toMatchObject({ status: 422 });
    await expect(requestEmailChange(ctx, { newEmail: u.email, password: TEST_PASSWORD })).rejects.toMatchObject({ status: 422 });

    const e1 = uniqueEmail('once');
    await requestEmailChange(ctx, { newEmail: e1, password: TEST_PASSWORD });
    const token = await latestEmailToken(e1);
    await confirmEmailChange(token, testMeta());
    await expect(confirmEmailChange(token, testMeta())).rejects.toMatchObject({ status: 400 });

    const u2 = await createUser();
    const c2 = await userContext(u2);
    const e2 = uniqueEmail('expiring');
    await requestEmailChange(c2, { newEmail: e2, password: TEST_PASSWORD });
    const t2 = await latestEmailToken(e2);
    await ownerQuery("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [hashToken(t2)]);
    await expect(confirmEmailChange(t2, testMeta())).rejects.toMatchObject({ status: 400 });
  });

  it('a newer request cancels the older link', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    const a = uniqueEmail('first');
    const b = uniqueEmail('second');
    await requestEmailChange(ctx, { newEmail: a, password: TEST_PASSWORD });
    const tokenA = await latestEmailToken(a);
    await requestEmailChange(ctx, { newEmail: b, password: TEST_PASSWORD });
    await expect(confirmEmailChange(tokenA, testMeta())).rejects.toMatchObject({ status: 400 });
    await expect(confirmEmailChange(await latestEmailToken(b), testMeta())).resolves.toBeUndefined();
  });

  it('gives no signal whether the new address is already taken, and never lets it be hijacked', async () => {
    const victim = await createUser();
    const attacker = await createUser();
    const ctx = await userContext(attacker);
    const fresh = uniqueEmail('free');
    const emailsBefore = await emailCountTo(victim.email);
    const a = await call(emailRoute, { token: ctx.token, body: { newEmail: fresh, password: TEST_PASSWORD } });
    const b = await call(emailRoute, { token: ctx.token, body: { newEmail: victim.email, password: TEST_PASSWORD } });
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(await emailCountTo(victim.email)).toBe(emailsBefore); // the existing owner was not emailed or exposed
    expect(await prisma().authToken.count({ where: { userId: attacker.id, type: 'EMAIL_CHANGE', newEmail: victim.email } })).toBe(0); // no token was ever minted for the taken address
    expect(await prisma().authToken.count({ where: { userId: attacker.id, type: 'EMAIL_CHANGE', newEmail: fresh } })).toBe(1); // the free one did get one
  });

  it('if the address becomes taken before confirming, the change fails safely', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    const target = uniqueEmail('race');
    await requestEmailChange(ctx, { newEmail: target, password: TEST_PASSWORD });
    const token = await latestEmailToken(target);
    await createUser({ email: target }); // someone registers it first
    await expect(confirmEmailChange(token, testMeta())).rejects.toMatchObject({ status: 400 });
    expect((await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(u.email);
  });

  it('requires a verified current email', async () => {
    const u = await createUser({ verified: false });
    const ctx = await userContext(u);
    const res = await call(emailRoute, { token: ctx.token, body: { newEmail: uniqueEmail(), password: TEST_PASSWORD } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('session management', () => {
  it('lists devices without ever exposing a token, and marks the current one', async () => {
    const u = await createUser();
    await ownerQuery('SELECT 1');
    const current = await userContext(u);
    await userContext(u);
    const res = await call(sessionsRoute, { token: current.token });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(current.token);
    expect(text).not.toMatch(/token/i);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['browser', 'createdAt', 'current', 'device', 'deviceType', 'id', 'ip', 'lastUsedAt', 'os']);
  });

  it('signs out one other device, or all other devices, but keeps the current one', async () => {
    const u = await createUser();
    const me = await userContext(u);
    const phone = await userContext(u);
    const laptop = await userContext(u);
    const tablet = await userContext(u);

    const r = await call(revokeRoute, { method: 'DELETE', token: me.token, params: { id: phone.sessionId }, body: {} });
    expect(r.status).toBe(200);
    expect(await authenticate(phone.token, testMeta())).toBeNull();
    expect(await authenticate(laptop.token, testMeta())).not.toBeNull();

    expect(await revokeOtherSessions(me)).toEqual({ revoked: 2 });
    expect(await authenticate(laptop.token, testMeta())).toBeNull();
    expect(await authenticate(tablet.token, testMeta())).toBeNull();
    expect(await authenticate(me.token, testMeta())).not.toBeNull();
    const events = await ownerQuery("SELECT action FROM audit_logs WHERE user_id = $1 AND action LIKE 'auth.session%'", [u.id]);
    expect(events.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['auth.session_revoked', 'auth.sessions_revoked']));
  });

  it('can sign out the current session too', async () => {
    const me = await userContext(await createUser());
    await revokeOwnSession(me, me.sessionId);
    expect(await authenticate(me.token, testMeta())).toBeNull();
  });

  it('cannot touch ANOTHER person’s session: their id is "not found" and their session survives', async () => {
    const mine = await userContext(await createUser());
    const victim = await userContext(await createUser());
    const res = await call(revokeRoute, { method: 'DELETE', token: mine.token, params: { id: victim.sessionId }, body: {} });
    expect(res.status).toBe(404);
    expect(await authenticate(victim.token, testMeta())).not.toBeNull();
    const none = await call(revokeRoute, { method: 'DELETE', token: mine.token, params: { id: '00000000-0000-4000-8000-000000000000' }, body: {} });
    expect(none.status).toBe(404);
    expect((await call(revokeRoute, { method: 'DELETE', token: mine.token, params: { id: 'not-a-uuid' }, body: {} })).status).toBe(422);
  });
});

describe('new sign-in alerts', () => {
  const uaA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
  const uaB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';

  it('warns about a device we have not seen — but not for the first sign-in or a known device', async () => {
    const u = await createUser();
    const meta = (ua: string) => ({ ...testMeta(), userAgent: ua });
    await login({ email: u.email, password: u.password }, meta(uaA));
    expect(await emailCountTo(u.email)).toBe(0); // first ever sign-in: no alert
    await login({ email: u.email, password: u.password }, meta(uaA));
    expect(await emailCountTo(u.email)).toBe(0); // same device
    await login({ email: u.email, password: u.password }, meta(uaB));
    const mail = await latestEmailTo(u.email);
    expect(mail?.subject).toMatch(/new sign-in/i);
    expect(mail?.text).toContain('Safari on iOS');
  });
});

describe('notification preferences', () => {
  it('optional categories can be switched off and are honoured; security alerts cannot be', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    expect((await getNotificationSettings(u.id)).optional.every((o) => o.emailEnabled)).toBe(true);
    await setNotificationPreferences(ctx, { preferences: { trial_reminders: false } });

    const recipient = { id: u.id, email: u.email, name: u.name };
    const before = await emailCountTo(u.email);
    expect(await emailUser(prisma(), recipient, 'trial_reminders', (to, n) => templates.trialReminder(to, n, 'X Co', 3, 'https://x'))).toBe(false);
    expect(await emailCountTo(u.email)).toBe(before);
    expect(await emailUser(prisma(), recipient, 'security', (to, n) => templates.mfaEnabled(to, n))).toBe(true);
    expect(await emailCountTo(u.email)).toBe(before + 1);

    await setNotificationPreferences(ctx, { preferences: { trial_reminders: true } });
    expect(await emailUser(prisma(), recipient, 'trial_reminders', (to, n) => templates.trialReminder(to, n, 'X Co', 3, 'https://x'))).toBe(true);
  });

  it('refuses to store a preference for a mandatory category', async () => {
    const ctx = await userContext(await createUser());
    await expect(setNotificationPreferences(ctx, { preferences: { security: false } })).rejects.toMatchObject({ status: 422 });
    await expect(setNotificationPreferences(ctx, { preferences: { billing: false } })).rejects.toMatchObject({ status: 422 });
  });
});

describe('my security activity', () => {
  it('shows my own account-level events and nobody else’s', async () => {
    const me = await createUser();
    const other = await createUser();
    await login({ email: me.email, password: me.password }, testMeta());
    await login({ email: other.email, password: other.password }, testMeta());
    const mine = await listMySecurityEvents(await userContext(me), {});
    expect(mine.items.some((e) => e.action === 'auth.login')).toBe(true);
    const otherIds = (await ownerQuery('SELECT id FROM audit_logs WHERE user_id = $1', [other.id])).rows.map((r) => r.id);
    expect(mine.items.every((e) => !otherIds.includes(e.id))).toBe(true);
    const total = (await ownerQuery('SELECT count(*)::int n FROM audit_logs WHERE user_id = $1 AND business_id IS NULL', [me.id])).rows[0]?.n;
    expect(mine.meta.total).toBe(total);
  });

  it('is enforced by the database, not just the query', async () => {
    const me = await createUser();
    await login({ email: me.email, password: me.password }, testMeta());
    // Without the per-user context the app role can see no account-level events at all.
    expect(await prisma().auditLog.findMany({ where: { userId: me.id } })).toEqual([]);
  });
});

describe('account deactivation', () => {
  it('a member can deactivate: signed out everywhere, cannot sign in, history kept, seat released', async () => {
    const ws = await createWorkspace('Leaver Co');
    const m = await createMemberCtx(ws, 'technician');
    const other = await userContext(m.user);
    await deactivateAccount(await userContext(m.user), { password: m.user.password });

    expect(await authenticate(m.ctx.token, testMeta())).toBeNull();
    expect(await authenticate(other.token, testMeta())).toBeNull();
    await expect(login({ email: m.user.email, password: m.user.password }, testMeta())).rejects.toMatchObject({ status: 401 });
    const row = await prisma().user.findUniqueOrThrow({ where: { id: m.user.id } });
    expect(row).toMatchObject({ status: 'DEACTIVATED' });
    expect(row.deactivatedAt).not.toBeNull();
    const membership = await prisma().membership.findUniqueOrThrow({ where: { id: m.ctx.membership.id } });
    expect(membership.status).toBe('SUSPENDED'); // history and the record remain; access is gone
    expect((await ownerQuery('SELECT 1 FROM users WHERE id = $1', [m.user.id])).rowCount).toBe(1); // never destroyed
  });

  it('needs the password, and an Owner cannot walk away from their business', async () => {
    const ws = await createWorkspace('Stuck Owner Co');
    const ctx = await userContext(ws.owner);
    await expect(deactivateAccount(ctx, { password: 'Wrong-Password-1!' })).rejects.toMatchObject({ status: 409 }); // blocked before the password is even considered
    await expect(deactivateAccount(ctx, { password: ws.owner.password })).rejects.toMatchObject({ status: 409 });
    expect((await prisma().user.findUniqueOrThrow({ where: { id: ws.owner.id } })).status).toBe('ACTIVE');

    const plain = await userContext(await createUser());
    await expect(deactivateAccount(plain, { password: 'Wrong-Password-1!' })).rejects.toMatchObject({ status: 422 });
    expect((await prisma().user.findUniqueOrThrow({ where: { id: plain.user.id } })).status).toBe('ACTIVE');
  });
});
