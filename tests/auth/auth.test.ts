import { afterAll, describe, expect, it } from 'vitest';
import { prisma, disconnectPrisma } from '@/server/db/client';
import { authenticate } from '@/server/tenancy/context';
import { changePassword, login, register, requestPasswordReset, resetPassword, verifyEmail } from '@/server/auth/service';
import { revokeSession } from '@/server/auth/session';
import { hashToken } from '@/server/security/crypto';

import { MemoryTransport } from '@/server/notifications/email';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as logoutRoute } from '@/app/api/v1/auth/logout/route';
import { call, sessionTokenFrom } from '../helpers/http';
import {
  createUser, drainJobs, emailCountTo, latestEmailToken, latestEmailTo, ownerQuery, testMeta, TEST_PASSWORD, uniqueEmail, userContext,
} from '../helpers/factory';

afterAll(disconnectPrisma);

const NEW_PASSWORD = 'Brand-New-Passw0rd!';

describe('registration', () => {
  it('creates an unverified account with an argon2id hash and queues a verification email', async () => {
    const email = uniqueEmail('reg');
    await register({ firstName: 'Reg', lastName: 'User', email, password: TEST_PASSWORD }, testMeta());
    const u = await prisma().user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).toBeNull();
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
    expect(u.passwordHash).not.toContain(TEST_PASSWORD);
    expect((await latestEmailTo(email))?.subject).toMatch(/verify/i);
  });

  it('stores only a hash of the verification token', async () => {
    const email = uniqueEmail('hash');
    await register({ firstName: 'Hash', lastName: 'User', email, password: TEST_PASSWORD }, testMeta());
    const token = await latestEmailToken(email);
    const rows = await ownerQuery('SELECT token_hash FROM auth_tokens WHERE token_hash = $1', [token]);
    expect(rows.rowCount).toBe(0); // raw token is never stored
    const hashed = await ownerQuery('SELECT 1 FROM auth_tokens WHERE token_hash = $1', [hashToken(token)]);
    expect(hashed.rowCount).toBe(1);
  });

  it('gives an identical API response for new and existing emails (no account enumeration)', async () => {
    const existing = await createUser();
    const body = (email: string) => ({ firstName: 'Some', lastName: 'One', email, password: TEST_PASSWORD });
    const a = await call(registerRoute, { body: body(uniqueEmail('fresh')) });
    const b = await call(registerRoute, { body: body(existing.email) });
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    // The existing owner is notified instead, and no duplicate account exists.
    expect((await latestEmailTo(existing.email))?.subject).toMatch(/already|tried to register/i);
    expect(await prisma().user.count({ where: { email: existing.email } })).toBe(1);
  });

  it('rejects weak passwords and bad emails with field errors', async () => {
    const res = await call(registerRoute, { body: { firstName: 'X', lastName: 'Y', email: 'nope', password: 'password123' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('rate-limits registration per IP', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 10; i++) {
      const r = await call(registerRoute, { headers: { 'x-real-ip': ip }, body: { firstName: 'Bot', lastName: 'B', email: uniqueEmail('bot'), password: TEST_PASSWORD } });
      expect(r.status).toBe(202);
    }
    const blocked = await call(registerRoute, { headers: { 'x-real-ip': ip }, body: { firstName: 'Bot', lastName: 'B', email: uniqueEmail('bot'), password: TEST_PASSWORD } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });
});

describe('email verification', () => {
  it('verifies once; the link cannot be reused', async () => {
    const email = uniqueEmail('ver');
    await register({ firstName: 'V', lastName: 'W', email, password: TEST_PASSWORD }, testMeta());
    const token = await latestEmailToken(email);
    await verifyEmail(token, testMeta());
    expect((await prisma().user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).not.toBeNull();
    await expect(verifyEmail(token, testMeta())).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown and expired tokens', async () => {
    await expect(verifyEmail('x'.repeat(43), testMeta())).rejects.toMatchObject({ status: 400 });
    const email = uniqueEmail('exp');
    await register({ firstName: 'E', lastName: 'F', email, password: TEST_PASSWORD }, testMeta());
    const token = await latestEmailToken(email);
    await ownerQuery("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [hashToken(token)]);
    await expect(verifyEmail(token, testMeta())).rejects.toMatchObject({ status: 400 });
  });
});

describe('login and sessions', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie and returns no token in the body', async () => {
    const u = await createUser();
    const res = await call(loginRoute, { body: { email: u.email, password: u.password } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(JSON.stringify(res.body)).not.toContain(sessionTokenFrom(res)!);
    const row = await ownerQuery('SELECT token_hash FROM sessions WHERE user_id = $1', [u.id]);
    expect(row.rows[0]?.token_hash).toBe(hashToken(sessionTokenFrom(res)!)); // only the hash is stored
  });

  it('treats unknown email and wrong password identically', async () => {
    const u = await createUser();
    const wrongPw = await call(loginRoute, { body: { email: u.email, password: 'Wrong-Password-1!' } });
    const noUser = await call(loginRoute, { body: { email: uniqueEmail('ghost'), password: 'Wrong-Password-1!' } });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(noUser.body.error.message).toBe(wrongPw.body.error.message);
    expect(noUser.body.error.code).toBe(wrongPw.body.error.code);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const u = await createUser();
    for (let i = 0; i < 5; i++) await expect(login({ email: u.email, password: 'Nope-Nope-1234' }, testMeta())).rejects.toMatchObject({ status: 401 });
    await expect(login({ email: u.email, password: u.password }, testMeta())).rejects.toMatchObject({ status: 429 });
    const events = await ownerQuery("SELECT action FROM audit_logs WHERE user_id = $1 AND action LIKE 'auth.login%'", [u.id]);
    expect(events.rows.map((r) => r.action)).toContain('auth.login_locked');
  });

  it('a successful login resets the failure counter and is audited', async () => {
    const u = await createUser();
    await expect(login({ email: u.email, password: 'Nope-Nope-1234' }, testMeta())).rejects.toThrow();
    await login({ email: u.email, password: u.password }, testMeta());
    expect((await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).failedLoginCount).toBe(0);
    const events = await ownerQuery("SELECT action FROM audit_logs WHERE user_id = $1", [u.id]);
    expect(events.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.login']));
  });

  it('logout revokes the session server-side', async () => {
    const u = await createUser();
    const res = await call(loginRoute, { body: { email: u.email, password: u.password } });
    const token = sessionTokenFrom(res)!;
    expect(await authenticate(token, testMeta())).not.toBeNull();
    const out = await call(logoutRoute, { token, body: {} });
    expect(out.status).toBe(200);
    expect(await authenticate(token, testMeta())).toBeNull(); // the stolen cookie is now worthless
  });

  it('rejects expired, revoked, forged and disabled-user sessions', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    await ownerQuery("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [ctx.sessionId]);
    expect(await authenticate(ctx.token, testMeta())).toBeNull();

    const ctx2 = await userContext(u);
    await revokeSession(prisma(), ctx2.sessionId);
    expect(await authenticate(ctx2.token, testMeta())).toBeNull();

    expect(await authenticate('totally-forged-token-value-123456789', testMeta())).toBeNull();
    expect(await authenticate(undefined, testMeta())).toBeNull();

    const ctx3 = await userContext(u);
    await prisma().user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } });
    expect(await authenticate(ctx3.token, testMeta())).toBeNull();
  });
});

describe('password reset', () => {
  it('gives no signal about whether an email exists', async () => {
    const before = await emailCountTo('nobody-here@example.test');
    await requestPasswordReset({ email: 'nobody-here@example.test' }, testMeta());
    expect(await emailCountTo('nobody-here@example.test')).toBe(before); // nothing sent, nothing thrown
  });

  it('resets the password with a single-use token and signs out every session', async () => {
    const u = await createUser();
    const s1 = await userContext(u);
    await requestPasswordReset({ email: u.email }, testMeta());
    const token = await latestEmailToken(u.email);

    await resetPassword({ token, password: NEW_PASSWORD }, testMeta());
    expect(await authenticate(s1.token, testMeta())).toBeNull();
    await expect(login({ email: u.email, password: u.password }, testMeta())).rejects.toMatchObject({ status: 401 });
    await expect(login({ email: u.email, password: NEW_PASSWORD }, testMeta())).resolves.toBeTruthy();
    await expect(resetPassword({ token, password: 'Another-Passw0rd!' }, testMeta())).rejects.toMatchObject({ status: 400 });
  });

  it('a newer reset request invalidates the older link', async () => {
    const u = await createUser();
    await requestPasswordReset({ email: u.email }, testMeta());
    const old = await latestEmailToken(u.email);
    await requestPasswordReset({ email: u.email }, testMeta());
    await expect(resetPassword({ token: old, password: NEW_PASSWORD }, testMeta())).rejects.toMatchObject({ status: 400 });
  });

  it('enforces the password policy and expiry', async () => {
    const u = await createUser();
    await requestPasswordReset({ email: u.email }, testMeta());
    const token = await latestEmailToken(u.email);
    await expect(resetPassword({ token, password: 'password123' }, testMeta())).rejects.toMatchObject({ status: 422 });
    await ownerQuery("UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(token)]);
    await expect(resetPassword({ token, password: NEW_PASSWORD }, testMeta())).rejects.toMatchObject({ status: 400 });
  });

  it('an email token cannot be used as a different token type', async () => {
    const email = uniqueEmail('xtype');
    await register({ firstName: 'X', lastName: 'Z', email, password: TEST_PASSWORD }, testMeta());
    const verifyToken = await latestEmailToken(email);
    await expect(resetPassword({ token: verifyToken, password: NEW_PASSWORD }, testMeta())).rejects.toMatchObject({ status: 400 });
  });
});

describe('change password', () => {
  it('requires the current password, revokes other sessions, keeps the current one', async () => {
    const u = await createUser();
    const current = await userContext(u);
    const other = await userContext(u);
    await expect(changePassword(current, { currentPassword: 'wrong-wrong-1', newPassword: NEW_PASSWORD })).rejects.toMatchObject({ status: 422 });
    await changePassword(current, { currentPassword: u.password, newPassword: NEW_PASSWORD });
    expect(await authenticate(current.token, testMeta())).not.toBeNull();
    expect(await authenticate(other.token, testMeta())).toBeNull();
    await drainJobs();
    expect(MemoryTransport.sent.some((m) => m.to === u.email && /changed/i.test(m.subject))).toBe(true);
  });
});
