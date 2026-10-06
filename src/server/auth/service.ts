import { z } from 'zod';
import { prisma, withTx, type Db, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { appUrl } from '@/lib/url';
import { describeUserAgent } from '@/lib/user-agent';
import { formatDateTime } from '@/lib/format';
import { emailSchema, nameSchema, optionalPhone, passwordSchema, parseOrThrow } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { alertInApp, emailUser, queueEmail } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { consumeAll } from '@/server/security/rate-limit';
import { generateToken, hashToken } from '@/server/security/crypto';
import type { RequestMeta, UserContext } from '@/server/context';
import { dummyVerify, hashPassword, verifyPassword } from './password';
import { createSession, revokeSession, revokeUserSessions, type CreatedSession } from './session';
import { verifySecondFactor } from './mfa';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 3600_000;
const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
const MFA_MAX_ATTEMPTS = 5;

export const registerSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  mobile: optionalPhone,
  email: emailSchema,
  password: passwordSchema,
});
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });
export const mfaLoginSchema = z.object({ challengeToken: z.string().min(20).max(200), code: z.string().trim().min(6).max(20) });
export const resetRequestSchema = z.object({ email: emailSchema });
export const resetCompleteSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
  confirmPassword: z.string().optional(),
}).refine((v) => v.confirmPassword === undefined || v.confirmPassword === v.newPassword, {
  path: ['confirmPassword'],
  message: 'The two passwords do not match',
});

const ip = (meta: RequestMeta) => meta.ip ?? 'unknown';
export const displayName = (first: string, last: string) => `${first} ${last}`.trim();

async function issueToken(db: Db, userId: string, type: 'EMAIL_VERIFY' | 'PASSWORD_RESET', ttlMs: number): Promise<string> {
  const token = generateToken();
  await db.authToken.create({ data: { userId, type, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

/**
 * Register a new account. The response is identical whether or not the email is
 * already registered (no account enumeration): existing owners get an email
 * instead. Throws only for invalid input or rate limiting.
 */
export async function register(input: unknown, meta: RequestMeta): Promise<void> {
  const data = parseOrThrow(registerSchema, input);
  await consumeAll([
    { key: `register:ip:${ip(meta)}`, limit: 10, windowSec: 3600 },
    { key: `register:email:${data.email}`, limit: 5, windowSec: 3600 },
  ]);

  // Hash up-front in both branches so timing doesn't reveal whether the email exists.
  const passwordHash = await hashPassword(data.password);
  const existing = await prisma().user.findUnique({ where: { email: data.email } });

  if (existing) {
    await queueEmail(prisma(), templates.accountExists(existing.email, existing.name, appUrl('/forgot-password')));
    return;
  }

  try {
    await withTx(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          name: displayName(data.firstName, data.lastName),
          mobile: data.mobile,
          passwordHash,
          passwordChangedAt: new Date(),
        },
      });
      const token = await issueToken(tx, user.id, 'EMAIL_VERIFY', VERIFY_TTL_MS);
      await queueEmail(tx, templates.verifyEmail(user.email, user.firstName || user.name, appUrl(`/verify-email?token=${token}`)));
      await recordAudit(tx, meta, { action: AuditActions.accountCreated, userId: user.id, resourceType: 'user', resourceId: user.id });
    });
  } catch (err) {
    // Lost a race with a concurrent registration of the same email: behave as "exists".
    if ((err as { code?: string }).code === 'P2002') return;
    throw err;
  }
}

export async function verifyEmail(token: string, meta: RequestMeta): Promise<void> {
  const hash = hashToken(token);
  await withTx(async (tx) => {
    const t = await tx.authToken.findUnique({ where: { tokenHash: hash } });
    if (!t || t.type !== 'EMAIL_VERIFY' || t.usedAt || t.expiresAt <= new Date()) {
      throw Errors.badRequest('This verification link is invalid or has expired.');
    }
    const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw Errors.badRequest('This verification link is invalid or has expired.');
    await tx.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
    await recordAudit(tx, meta, { action: AuditActions.emailVerified, userId: t.userId, resourceType: 'user', resourceId: t.userId });
  });
}

export async function resendVerification(ctx: UserContext): Promise<void> {
  await consumeAll([{ key: `verify-resend:user:${ctx.user.id}`, limit: 5, windowSec: 3600 }]);
  if (ctx.user.emailVerified) return;
  await withTx(async (tx) => {
    await tx.authToken.updateMany({ where: { userId: ctx.user.id, type: 'EMAIL_VERIFY', usedAt: null }, data: { usedAt: new Date() } });
    const token = await issueToken(tx, ctx.user.id, 'EMAIL_VERIFY', VERIFY_TTL_MS);
    await queueEmail(tx, templates.verifyEmail(ctx.user.email, ctx.user.name, appUrl(`/verify-email?token=${token}`)));
  });
}

export type LoginResult =
  | { kind: 'session'; session: CreatedSession; userId: string; /** @deprecated use kind */ mfa?: false }
  | { kind: 'mfa'; challengeToken: string; userId: string };

const INVALID_LOGIN = () => Errors.unauthenticated('Invalid email or password.');

/** Shared tail of every successful sign-in (with or without MFA): bookkeeping, session, alert. */
async function finishLogin(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  user: { id: string; email: string; name: string; firstName: string },
  meta: RequestMeta,
  via: { mfa: boolean; recoveryCode?: boolean },
): Promise<CreatedSession> {
  const ua = meta.userAgent ?? null;
  const [priorSessions, sameDevice] = await seq([
    tx.session.count({ where: { userId: user.id } }),
    ua ? tx.session.count({ where: { userId: user.id, userAgent: ua.slice(0, 300) } }) : Promise.resolve(0),
  ]);
  await tx.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: meta.ip ?? null, lastLoginUserAgent: ua?.slice(0, 300) ?? null },
  });
  const first = await tx.membership.findFirst({
    where: { userId: user.id, status: 'ACTIVE', business: { status: 'ACTIVE' } },
    orderBy: { joinedAt: 'asc' },
    select: { businessId: true },
  });
  const session = await createSession(tx, user.id, meta, first?.businessId);
  await recordAudit(tx, meta, {
    action: AuditActions.loginSucceeded,
    userId: user.id,
    resourceType: 'user',
    resourceId: user.id,
    metadata: { mfa: via.mfa, ...(via.recoveryCode ? { recoveryCode: true } : {}) },
  });
  // Security alert for a sign-in from a device we have not seen (not for the very first session).
  if (priorSessions > 0 && sameDevice === 0) {
    const d = describeUserAgent(ua);
    await emailUser(tx, { id: user.id, email: user.email, name: user.firstName || user.name }, 'security', (to, name) =>
      templates.newLogin(to, name, { device: d.label, ip: meta.ip, at: formatDateTime(new Date(), 'Africa/Johannesburg', 'en-ZA') }),
    );
  }
  return session;
}

export async function login(input: unknown, meta: RequestMeta): Promise<LoginResult> {
  const data = parseOrThrow(loginSchema, input);
  await consumeAll([
    { key: `login:ip:${ip(meta)}`, limit: 30, windowSec: 900 },
    { key: `login:email:${data.email}`, limit: 10, windowSec: 900 },
  ]);

  const user = await prisma().user.findUnique({ where: { email: data.email } });
  if (!user) {
    await dummyVerify(data.password);
    throw INVALID_LOGIN();
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await dummyVerify(data.password);
    throw Errors.rateLimited(Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000));
  }

  const ok = user.status === 'ACTIVE' && (await verifyPassword(user.passwordHash, data.password));
  if (!ok) {
    const updated = await prisma().user.update({ where: { id: user.id }, data: { failedLoginCount: { increment: 1 } } });
    const locked = updated.failedLoginCount >= MAX_FAILED_LOGINS;
    if (locked) {
      await prisma().user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
      });
    }
    await recordAudit(prisma(), meta, {
      action: locked ? AuditActions.loginLocked : AuditActions.loginFailed,
      userId: user.id,
      resourceType: 'user',
      resourceId: user.id,
    });
    throw INVALID_LOGIN();
  }

  // Password correct. With MFA on, no session exists yet: hand back a short-lived, single-use challenge.
  if (user.mfaEnabled) {
    const challengeToken = generateToken();
    await prisma().mfaChallenge.create({
      data: { userId: user.id, tokenHash: hashToken(challengeToken), ip: meta.ip ?? null, expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS) },
    });
    return { kind: 'mfa', challengeToken, userId: user.id };
  }

  const session = await withTx((tx) => finishLogin(tx, user, meta, { mfa: false }));
  return { kind: 'session', session, userId: user.id };
}

/** Second step of an MFA login: authenticator code or a recovery code. */
export async function completeMfaLogin(input: unknown, meta: RequestMeta): Promise<{ session: CreatedSession; userId: string }> {
  const data = parseOrThrow(mfaLoginSchema, input);
  await consumeAll([{ key: `mfa:ip:${ip(meta)}`, limit: 30, windowSec: 900 }]);
  const invalid = () => Errors.unauthenticated('That code is not valid, or the sign-in expired. Start again.');

  const challenge = await prisma().mfaChallenge.findUnique({ where: { tokenHash: hashToken(data.challengeToken) } });
  if (!challenge || challenge.usedAt || challenge.expiresAt <= new Date()) throw invalid();

  // Burn an attempt atomically; a challenge allows only a handful of guesses in total.
  const bumped = await prisma().mfaChallenge.updateMany({
    where: { id: challenge.id, usedAt: null, attempts: { lt: MFA_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (bumped.count !== 1) throw invalid();
  await consumeAll([{ key: `mfa:user:${challenge.userId}`, limit: 20, windowSec: 900 }]);

  const user = await prisma().user.findUniqueOrThrow({ where: { id: challenge.userId } });
  if (user.status !== 'ACTIVE' || !user.mfaEnabled) throw invalid();

  const method = await verifySecondFactor(prisma(), user, data.code);
  if (!method) {
    await recordAudit(prisma(), meta, { action: AuditActions.mfaChallengeFailed, userId: user.id, resourceType: 'user', resourceId: user.id });
    throw invalid();
  }

  return withTx(async (tx) => {
    const claimed = await tx.mfaChallenge.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw invalid();
    if (method === 'recovery') {
      await recordAudit(tx, meta, { action: AuditActions.mfaRecoveryCodeUsed, userId: user.id, resourceType: 'user', resourceId: user.id });
    }
    const session = await finishLogin(tx, user, meta, { mfa: true, recoveryCode: method === 'recovery' });
    return { session, userId: user.id };
  });
}

export async function logout(ctx: UserContext): Promise<void> {
  await withTx(async (tx) => {
    await revokeSession(tx, ctx.sessionId);
    await recordAudit(tx, ctx.meta, { action: AuditActions.logout, userId: ctx.user.id });
  });
}

/** Always resolves without revealing whether the email has an account. */
export async function requestPasswordReset(input: unknown, meta: RequestMeta): Promise<void> {
  const data = parseOrThrow(resetRequestSchema, input);
  await consumeAll([
    { key: `reset:ip:${ip(meta)}`, limit: 10, windowSec: 3600 },
    { key: `reset:email:${data.email}`, limit: 3, windowSec: 3600 },
  ]);
  const user = await prisma().user.findUnique({ where: { email: data.email } });
  if (!user || user.status !== 'ACTIVE') return;

  await withTx(async (tx) => {
    await tx.authToken.updateMany({ where: { userId: user.id, type: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: new Date() } });
    const token = await issueToken(tx, user.id, 'PASSWORD_RESET', RESET_TTL_MS);
    await queueEmail(tx, templates.passwordReset(user.email, user.name, appUrl(`/reset-password?token=${token}`)));
    await recordAudit(tx, meta, { action: AuditActions.passwordResetRequested, userId: user.id, resourceType: 'user', resourceId: user.id });
  });
}

export async function resetPassword(input: unknown, meta: RequestMeta): Promise<void> {
  const data = parseOrThrow(resetCompleteSchema, input);
  await consumeAll([{ key: `reset-complete:ip:${ip(meta)}`, limit: 20, windowSec: 3600 }]);
  const passwordHash = await hashPassword(data.password);
  const tokenHash = hashToken(data.token);

  await withTx(async (tx) => {
    const t = await tx.authToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!t || t.type !== 'PASSWORD_RESET' || t.usedAt || t.expiresAt <= new Date()) {
      throw Errors.badRequest('This reset link is invalid or has expired.');
    }
    const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw Errors.badRequest('This reset link is invalid or has expired.');

    await tx.user.update({
      where: { id: t.userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        // Receiving the reset email proves control of the address.
        emailVerifiedAt: t.user.emailVerifiedAt ?? new Date(),
      },
    });
    const revoked = await revokeUserSessions(tx, t.userId);
    const pwMail = templates.passwordChanged(t.user.email, t.user.firstName || t.user.name);
    await queueEmail(tx, pwMail);
    await alertInApp(t.userId, pwMail);
    await recordAudit(tx, meta, {
      action: AuditActions.passwordResetCompleted,
      userId: t.userId,
      resourceType: 'user',
      resourceId: t.userId,
      metadata: { sessionsRevoked: revoked },
    });
  });
}

export async function changePassword(ctx: UserContext, input: unknown): Promise<void> {
  const data = parseOrThrow(changePasswordSchema, input);
  await consumeAll([{ key: `change-password:user:${ctx.user.id}`, limit: 10, windowSec: 3600 }]);
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!(await verifyPassword(user.passwordHash, data.currentPassword))) {
    throw Errors.validation({ currentPassword: 'Current password is incorrect.' });
  }
  const passwordHash = await hashPassword(data.newPassword);
  await withTx(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
    const revoked = await revokeUserSessions(tx, user.id, ctx.sessionId);
    const pwMail = templates.passwordChanged(user.email, user.firstName || user.name);
    await queueEmail(tx, pwMail);
    await alertInApp(user.id, pwMail);
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.passwordChanged,
      userId: user.id,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { otherSessionsRevoked: revoked },
    });
  });
}
