import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { authenticate } from '@/server/tenancy/context';
import { completeMfaLogin, login } from '@/server/auth/service';
import { disableMfa, enableMfa, getMfaStatus, regenerateRecoveryCodes, startMfaSetup } from '@/server/auth/mfa';
import { currentStep, decryptSecret, totpAtStep } from '@/server/auth/totp';
import { hashToken } from '@/server/security/crypto';
import { setMfaRequirement } from '@/server/businesses/service';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as mfaVerifyRoute } from '@/app/api/v1/auth/mfa/verify/route';
import { POST as setupRoute } from '@/app/api/v1/account/mfa/setup/route';
import { GET as mfaStatusRoute } from '@/app/api/v1/account/mfa/route';
import { GET as customersRoute } from '@/app/api/v1/customers/route';
import { GET as accountRoute } from '@/app/api/v1/account/route';
import { call, sessionTokenFrom } from '../helpers/http';
import { enableMfaFor, freshCode } from '../helpers/mfa';
import {
  businessContext, createMemberCtx, createUser, createWorkspace, latestEmailTo, ownerQuery, testMeta, upgradePlan, userContext,
} from '../helpers/factory';

afterAll(disconnectPrisma);

describe('MFA enrolment', () => {
  it('setup shows the secret and a QR code, but nothing is active until a real code proves the app works', async () => {
    const u = await createUser();
    const ctx = await userContext(u);
    const setup = await startMfaSetup(ctx);
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    expect(setup.qrSvg).toMatch(/^<\?xml|^<svg/);
    expect((await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).mfaEnabled).toBe(false);
    // the pending secret is stored encrypted, never in the clear
    const row = (await ownerQuery('SELECT mfa_pending_secret_enc FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row.mfa_pending_secret_enc).not.toContain(setup.secret);

    await expect(enableMfa(ctx, { code: '000000' })).rejects.toMatchObject({ status: 422 });
    await expect(enableMfa(ctx, { code: 'abcdef' })).rejects.toMatchObject({ status: 422 });
    expect((await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).mfaEnabled).toBe(false);
  });

  it('enabling needs a correct code, returns 10 one-time recovery codes, stores only hashes, and encrypts the secret', async () => {
    const u = await createUser();
    const { secret, recoveryCodes } = await enableMfaFor(u);
    expect(recoveryCodes).toHaveLength(10);

    const row = (await ownerQuery('SELECT mfa_enabled, mfa_secret_enc, mfa_pending_secret_enc, mfa_last_used_step FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row.mfa_enabled).toBe(true);
    expect(row.mfa_secret_enc).not.toContain(secret);
    expect(decryptSecret(row.mfa_secret_enc)).toBe(secret);
    expect(row.mfa_pending_secret_enc).toBeNull();

    const stored = (await ownerQuery('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [u.id])).rows.map((r) => r.code_hash as string);
    expect(stored).toHaveLength(10);
    for (const c of recoveryCodes) expect(stored.join(' ')).not.toContain(c.replace('-', ''));
    expect(await getMfaStatus(u.id)).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE user_id = $1 AND action = 'auth.mfa_enabled'", [u.id]);
    expect(audit.rowCount).toBe(1);
    expect((await latestEmailTo(u.email))?.subject).toMatch(/two-factor authentication turned on/i); // security alert
  });

  it('enabling signs out other devices so they must prove the second factor next time', async () => {
    const u = await createUser();
    const otherDevice = await userContext(u);
    const { ctx } = await enableMfaFor(u);
    expect(await authenticate(otherDevice.token, testMeta())).toBeNull();
    expect(await authenticate(ctx.token, testMeta())).not.toBeNull();
  });

  it('cannot enrol twice, and the status endpoint never reveals secrets', async () => {
    const u = await createUser();
    const { ctx } = await enableMfaFor(u);
    await expect(startMfaSetup(ctx)).rejects.toMatchObject({ status: 409 });
    const res = await call(mfaStatusRoute, { token: ctx.token });
    expect(res.body.data).toEqual({ enabled: true, enabledAt: expect.any(String), recoveryCodesRemaining: 10 });
  });

  it('rate-limits enrolment attempts', async () => {
    const ctx = await userContext(await createUser());
    await startMfaSetup(ctx);
    let blocked = false;
    for (let i = 0; i < 12; i++) {
      try { await enableMfa(ctx, { code: '000000' }); } catch (e) { if ((e as { status?: number }).status === 429) { blocked = true; break; } }
    }
    expect(blocked).toBe(true);
  });

  it('setup requires authentication', async () => {
    expect((await call(setupRoute, { body: {} })).status).toBe(401);
  });
});

describe('MFA challenge at sign-in', () => {
  it('a correct password alone yields NO session — only a short-lived challenge', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const res = await call(loginRoute, { body: { email: u.email, password: u.password } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mfaRequired: true });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(sessionTokenFrom(res)).toBeUndefined();
    const sessionsBefore = await prisma().session.count({ where: { userId: u.id } });
    expect(sessionsBefore).toBe(1); // just the enrolment session; login created none
    const stored = await ownerQuery('SELECT token_hash FROM mfa_challenges WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [u.id]);
    expect(stored.rows[0]?.token_hash).toBe(hashToken(res.body.data.challengeToken)); // stored hashed
  });

  it('the challenge plus a valid authenticator code yields a session cookie', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const step1 = await call(loginRoute, { body: { email: u.email, password: u.password } });
    const done = await call(mfaVerifyRoute, { body: { challengeToken: step1.body.data.challengeToken, code: await freshCode(u) } });
    expect(done.status).toBe(200);
    const token = sessionTokenFrom(done)!;
    expect(token).toBeTruthy();
    expect(await authenticate(token, testMeta())).not.toBeNull();
    const evt = await ownerQuery("SELECT metadata FROM audit_logs WHERE user_id = $1 AND action = 'auth.login' ORDER BY created_at DESC LIMIT 1", [u.id]);
    expect(evt.rows[0]?.metadata).toMatchObject({ mfa: true });
  });

  it('a wrong password never reaches the second step', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const res = await call(loginRoute, { body: { email: u.email, password: 'Wrong-Password-1!' } });
    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('a code cannot be replayed, even on a fresh challenge', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const c1 = await login({ email: u.email, password: u.password }, testMeta());
    if (c1.kind !== 'mfa') throw new Error('expected challenge');
    const code = await freshCode(u);
    await expect(completeMfaLogin({ challengeToken: c1.challengeToken, code }, testMeta())).resolves.toBeTruthy();

    const c2 = await login({ email: u.email, password: u.password }, testMeta());
    if (c2.kind !== 'mfa') throw new Error('expected challenge');
    await expect(completeMfaLogin({ challengeToken: c2.challengeToken, code }, testMeta())).rejects.toMatchObject({ status: 401 });
  });

  it('a challenge is single-use', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const c = await login({ email: u.email, password: u.password }, testMeta());
    if (c.kind !== 'mfa') throw new Error('expected challenge');
    await completeMfaLogin({ challengeToken: c.challengeToken, code: await freshCode(u) }, testMeta());
    await expect(completeMfaLogin({ challengeToken: c.challengeToken, code: await freshCode(u) }, testMeta())).rejects.toMatchObject({ status: 401 });
  });

  it('brute force is capped: after 5 wrong guesses the challenge is dead even for the right code', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const c = await login({ email: u.email, password: u.password }, testMeta());
    if (c.kind !== 'mfa') throw new Error('expected challenge');
    for (let i = 0; i < 5; i++) await expect(completeMfaLogin({ challengeToken: c.challengeToken, code: '000000' }, testMeta())).rejects.toMatchObject({ status: 401 });
    await expect(completeMfaLogin({ challengeToken: c.challengeToken, code: await freshCode(u) }, testMeta())).rejects.toMatchObject({ status: 401 });
    const events = await ownerQuery("SELECT 1 FROM audit_logs WHERE user_id = $1 AND action = 'auth.mfa_challenge_failed'", [u.id]);
    expect(events.rowCount).toBe(5);
  });

  it('expired and forged challenges are rejected', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const c = await login({ email: u.email, password: u.password }, testMeta());
    if (c.kind !== 'mfa') throw new Error('expected challenge');
    await ownerQuery("UPDATE mfa_challenges SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(c.challengeToken)]);
    await expect(completeMfaLogin({ challengeToken: c.challengeToken, code: await freshCode(u) }, testMeta())).rejects.toMatchObject({ status: 401 });
    await expect(completeMfaLogin({ challengeToken: 'f'.repeat(43), code: '123456' }, testMeta())).rejects.toMatchObject({ status: 401 });
  });

  it('a challenge for one person cannot be completed with another person’s code', async () => {
    const a = await createUser();
    const b = await createUser();
    await enableMfaFor(a);
    await enableMfaFor(b);
    const ca = await login({ email: a.email, password: a.password }, testMeta());
    if (ca.kind !== 'mfa') throw new Error('expected challenge');
    await expect(completeMfaLogin({ challengeToken: ca.challengeToken, code: await freshCode(b) }, testMeta())).rejects.toMatchObject({ status: 401 });
  });
});

describe('recovery codes', () => {
  it('each recovery code signs you in exactly once, and is audited', async () => {
    const u = await createUser();
    const { recoveryCodes } = await enableMfaFor(u);
    const code = recoveryCodes[0]!;

    const c1 = await login({ email: u.email, password: u.password }, testMeta());
    if (c1.kind !== 'mfa') throw new Error('expected challenge');
    await expect(completeMfaLogin({ challengeToken: c1.challengeToken, code }, testMeta())).resolves.toBeTruthy();
    expect(await getMfaStatus(u.id)).toMatchObject({ recoveryCodesRemaining: 9 });

    const c2 = await login({ email: u.email, password: u.password }, testMeta());
    if (c2.kind !== 'mfa') throw new Error('expected challenge');
    await expect(completeMfaLogin({ challengeToken: c2.challengeToken, code }, testMeta())).rejects.toMatchObject({ status: 401 }); // already spent
    const evt = await ownerQuery("SELECT 1 FROM audit_logs WHERE user_id = $1 AND action = 'auth.mfa_recovery_code_used'", [u.id]);
    expect(evt.rowCount).toBe(1);
  });

  it('typing a recovery code with different case or spacing still works', async () => {
    const u = await createUser();
    const { recoveryCodes } = await enableMfaFor(u);
    const c = await login({ email: u.email, password: u.password }, testMeta());
    if (c.kind !== 'mfa') throw new Error('expected challenge');
    await expect(completeMfaLogin({ challengeToken: c.challengeToken, code: recoveryCodes[1]!.toUpperCase().replace('-', '') }, testMeta())).resolves.toBeTruthy();
  });

  it('regenerating needs password + a code, and kills every old code', async () => {
    const u = await createUser();
    const { recoveryCodes, ctx } = await enableMfaFor(u);
    await expect(regenerateRecoveryCodes(ctx, { password: 'Wrong-Password-1!', code: await freshCode(u) })).rejects.toMatchObject({ status: 422 });
    await expect(regenerateRecoveryCodes(ctx, { password: u.password, code: '000000' })).rejects.toMatchObject({ status: 422 });
    const fresh = await regenerateRecoveryCodes(ctx, { password: u.password, code: await freshCode(u) });
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes).not.toEqual(expect.arrayContaining([recoveryCodes[0]]));
    const c = await login({ email: u.email, password: u.password }, testMeta());
    if (c.kind !== 'mfa') throw new Error('expected challenge');
    await expect(completeMfaLogin({ challengeToken: c.challengeToken, code: recoveryCodes[0]! }, testMeta())).rejects.toMatchObject({ status: 401 });
  });
});

describe('turning MFA off', () => {
  it('needs the password AND a current code, clears all MFA data, and alerts the owner of the account', async () => {
    const u = await createUser();
    const { ctx } = await enableMfaFor(u);
    await expect(disableMfa(ctx, { password: u.password, code: '000000' })).rejects.toMatchObject({ status: 422 });
    await expect(disableMfa(ctx, { password: 'Wrong-Password-1!', code: await freshCode(u) })).rejects.toMatchObject({ status: 422 });
    expect((await prisma().user.findUniqueOrThrow({ where: { id: u.id } })).mfaEnabled).toBe(true);

    await disableMfa(ctx, { password: u.password, code: await freshCode(u) });
    const row = (await ownerQuery('SELECT mfa_enabled, mfa_secret_enc, mfa_pending_secret_enc FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row).toEqual({ mfa_enabled: false, mfa_secret_enc: null, mfa_pending_secret_enc: null });
    expect((await ownerQuery('SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1', [u.id])).rowCount).toBe(0);
    expect((await latestEmailTo(u.email))?.subject).toMatch(/turned off/i);
    const r = await login({ email: u.email, password: u.password }, testMeta());
    expect(r.kind).toBe('session');
  });

  it('is refused while a business the person belongs to requires MFA', async () => {
    const ws = await createWorkspace('Strict Co');
    await upgradePlan(ws, 'business');
    await enableMfaFor(ws.owner);
    ws.ctx = await businessContext(ws.owner);
    await setMfaRequirement(ws.ctx, { required: true });
    const ctx = await userContext(ws.owner);
    await expect(disableMfa(ctx, { password: ws.owner.password, code: await freshCode(ws.owner) })).rejects.toMatchObject({ status: 409 });
  });
});

describe('business-wide MFA requirement', () => {
  it('only available on plans that include it, and only if the requester has MFA themselves', async () => {
    const solo = await createWorkspace('Solo MFA Co');
    await ownerQuery(`UPDATE subscriptions SET status='ACTIVE', trial_ends_at=NULL, current_period_end=now()+interval '30 days', plan_id=(SELECT id FROM plans WHERE key='solo') WHERE business_id=$1`, [solo.businessId]);
    solo.ctx = await businessContext(solo.owner);
    await expect(setMfaRequirement(solo.ctx, { required: true })).rejects.toMatchObject({ status: 402, code: 'FEATURE_NOT_IN_PLAN' });

    const ws = await createWorkspace('No Own MFA Co');
    await expect(setMfaRequirement(ws.ctx, { required: true })).rejects.toMatchObject({ status: 409 }); // would lock themselves out
  });

  it('members without MFA are locked out of business data (API) until they enable it, but can still reach their account', async () => {
    const ws = await createWorkspace('Enforcing Co');
    await enableMfaFor(ws.owner);
    ws.ctx = await businessContext(ws.owner);
    const member = await createMemberCtx(ws, 'manager');
    expect((await call(customersRoute, { token: member.ctx.token })).status).toBe(200); // fine before the rule

    await setMfaRequirement(ws.ctx, { required: true });
    const blocked = await call(customersRoute, { token: member.ctx.token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');
    expect((await call(accountRoute, { token: member.ctx.token })).status).toBe(200); // can reach the place to fix it

    await enableMfaFor(member.user);
    const again = await userContext(member.user);
    const { setActiveBusiness } = await import('@/server/auth/session');
    await setActiveBusiness(prisma(), again.sessionId, ws.businessId);
    expect((await call(customersRoute, { token: again.token })).status).toBe(200); // unblocked
  });

  it('turning the requirement off restores everyone, and the change is audited', async () => {
    const ws = await createWorkspace('Relax Co');
    await enableMfaFor(ws.owner);
    ws.ctx = await businessContext(ws.owner);
    const member = await createMemberCtx(ws, 'technician');
    await setMfaRequirement(ws.ctx, { required: true });
    expect((await call(customersRoute, { token: member.ctx.token })).status).toBe(403);
    await setMfaRequirement(ws.ctx, { required: false });
    expect((await call(customersRoute, { token: member.ctx.token })).status).toBe(200);
    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE business_id = $1 AND action = 'business.mfa_requirement_changed' ORDER BY created_at", [ws.businessId]);
    expect(a.rows.map((r) => r.after.requireMfa)).toEqual([true, false]);
  });

  it('currentStep-based codes from a different secret never work (sanity)', async () => {
    const u = await createUser();
    await enableMfaFor(u);
    const c = await login({ email: u.email, password: u.password }, testMeta());
    if (c.kind !== 'mfa') throw new Error('expected challenge');
    await ownerQuery('UPDATE users SET mfa_last_used_step = 0 WHERE id = $1', [u.id]);
    await expect(completeMfaLogin({ challengeToken: c.challengeToken, code: totpAtStep('JBSWY3DPEHPK3PXP', currentStep()) }, testMeta())).rejects.toMatchObject({ status: 401 });
  });
});
