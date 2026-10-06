import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma, withTx, withUser, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { appUrl } from '@/lib/url';
import { describeUserAgent } from '@/lib/user-agent';
import { emailSchema, nameSchema, optionalPhone, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { displayName } from '@/server/auth/service';
import { verifyPassword } from '@/server/auth/password';
import { reauthSchema, verifyReauth } from '@/server/auth/reauth';
import { revokeUserSessions } from '@/server/auth/session';
import { detectFileType } from '@/server/files/sniff';
import { alertInApp, emailUser, getPreferences, isOptionalCategory, OPTIONAL_CATEGORIES, queueEmail } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { consumeAll } from '@/server/security/rate-limit';
import { generateToken, hashToken } from '@/server/security/crypto';
import { getStorage } from '@/server/storage';
import type { UserContext } from '@/server/context';

const EMAIL_CHANGE_TTL_MS = 24 * 3600_000;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

// ─────────────── profile ───────────────

export const profileSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  mobile: optionalPhone,
});

export async function getAccount(userId: string) {
  const u = await prisma().user.findUniqueOrThrow({ where: { id: userId } });
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.emailVerifiedAt !== null,
    firstName: u.firstName,
    lastName: u.lastName,
    name: u.name,
    mobile: u.mobile,
    hasPhoto: u.profilePhotoKey !== null,
    status: u.status,
    mfaEnabled: u.mfaEnabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    passwordChangedAt: u.passwordChangedAt,
  };
}

export async function updateProfile(ctx: UserContext, input: unknown) {
  const data = parseOrThrow(profileSchema, input);
  return withTx(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    const after = await tx.user.update({
      where: { id: ctx.user.id },
      data: { firstName: data.firstName, lastName: data.lastName, name: displayName(data.firstName, data.lastName), mobile: data.mobile ?? null },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.profileUpdated,
      userId: ctx.user.id,
      resourceType: 'user',
      resourceId: ctx.user.id,
      before: { firstName: before.firstName, lastName: before.lastName, mobile: before.mobile },
      after: { firstName: after.firstName, lastName: after.lastName, mobile: after.mobile },
    });
    return { firstName: after.firstName, lastName: after.lastName, name: after.name, mobile: after.mobile };
  });
}

// ─────────────── profile photo ───────────────

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function setProfilePhoto(ctx: UserContext, data: Buffer, filename: string) {
  if (data.length === 0) throw Errors.validation({ photo: 'The file is empty.' });
  if (data.length > MAX_PHOTO_BYTES) throw Errors.tooLarge(2);
  const type = detectFileType(data, filename);
  if (!type || !PHOTO_TYPES.has(type.mime)) throw Errors.unsupportedMedia('Use a JPG, PNG or WebP photo.');

  const key = `${ctx.user.id}/avatar/${randomUUID()}`;
  const storage = getStorage();
  await storage.put(key, data, { contentType: type.mime });
  try {
    const previous = await withTx(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
      await tx.user.update({ where: { id: ctx.user.id }, data: { profilePhotoKey: key } });
      await recordAudit(tx, ctx.meta, { action: AuditActions.photoChanged, userId: ctx.user.id, resourceType: 'user', resourceId: ctx.user.id });
      return u.profilePhotoKey;
    });
    if (previous) await storage.delete(previous).catch(() => {});
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
}

export async function removeProfilePhoto(ctx: UserContext) {
  const u = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!u.profilePhotoKey) return;
  await withTx(async (tx) => {
    await tx.user.update({ where: { id: ctx.user.id }, data: { profilePhotoKey: null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.photoChanged, userId: ctx.user.id, resourceType: 'user', resourceId: ctx.user.id, metadata: { removed: true } });
  });
  await getStorage().delete(u.profilePhotoKey).catch(() => {});
}

/** A person's OWN photo only. (Showing teammates' photos would be a separate, business-scoped feature.) */
export async function openOwnPhoto(userId: string) {
  const u = await prisma().user.findUniqueOrThrow({ where: { id: userId } });
  if (!u.profilePhotoKey) throw Errors.notFound('Photo');
  const { stream, size } = await getStorage().get(u.profilePhotoKey);
  return { stream, size };
}

// ─────────────── notification preferences ───────────────

export const preferencesSchema = z.object({
  preferences: z.record(z.string(), z.boolean()).refine((p) => Object.keys(p).every(isOptionalCategory), 'Unknown notification category'),
});

export async function getNotificationSettings(userId: string) {
  const prefs = await getPreferences(prisma(), userId);
  return {
    optional: (Object.keys(OPTIONAL_CATEGORIES) as (keyof typeof OPTIONAL_CATEGORIES)[]).map((key) => ({ key, label: OPTIONAL_CATEGORIES[key], emailEnabled: prefs[key] })),
    // Security alerts are transactional and cannot be switched off.
    alwaysOn: ['Security alerts (new sign-ins, password and email changes, two-factor changes)', 'Account and billing notices for businesses you administer'],
  };
}

export async function setNotificationPreferences(ctx: UserContext, input: unknown) {
  const { preferences } = parseOrThrow(preferencesSchema, input);
  await withTx(async (tx) => {
    for (const [category, emailEnabled] of Object.entries(preferences)) {
      await tx.userNotificationPreference.upsert({
        where: { userId_category: { userId: ctx.user.id, category } },
        create: { userId: ctx.user.id, category, emailEnabled },
        update: { emailEnabled },
      });
    }
    await recordAudit(tx, ctx.meta, { action: AuditActions.notificationPrefsChanged, userId: ctx.user.id, metadata: { preferences } });
  });
}

// ─────────────── email change (verified, never trusted until confirmed) ───────────────

export const emailChangeSchema = z.object({ newEmail: emailSchema, password: z.string().min(1).max(128) });

export async function requestEmailChange(ctx: UserContext, input: unknown) {
  const data = parseOrThrow(emailChangeSchema, input);
  await consumeAll([{ key: `email-change:user:${ctx.user.id}`, limit: 5, windowSec: 3600 }]);
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!(await verifyPassword(user.passwordHash, data.password))) throw Errors.validation({ password: 'Incorrect password.' });
  if (data.newEmail === user.email) throw Errors.validation({ newEmail: 'That is already your email address.' });

  // Same answer whether or not the new address is taken (no enumeration); confirmation re-checks.
  const taken = await prisma().user.findUnique({ where: { email: data.newEmail }, select: { id: true } });
  const token = generateToken();
  await withTx(async (tx) => {
    await tx.authToken.updateMany({ where: { userId: user.id, type: 'EMAIL_CHANGE', usedAt: null }, data: { usedAt: new Date() } });
    if (!taken) {
      await tx.authToken.create({
        data: { userId: user.id, type: 'EMAIL_CHANGE', tokenHash: hashToken(token), newEmail: data.newEmail, expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) },
      });
      await queueEmail(tx, templates.emailChangeConfirm(data.newEmail, user.firstName || user.name, appUrl(`/confirm-email-change?token=${token}`)));
    }
    // The CURRENT address is always warned, so a hijacked session can't quietly redirect the account.
    await emailUser(tx, user, 'security', (to, name) => templates.emailChangeRequested(to, user.firstName || name, data.newEmail));
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.emailChangeRequested,
      userId: user.id,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { newEmailDomain: data.newEmail.split('@')[1] },
    });
  });
}

export async function confirmEmailChange(token: string, meta: UserContext['meta']) {
  const t = await prisma().authToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  const invalid = () => Errors.badRequest('This link is invalid or has expired.');
  if (!t || t.type !== 'EMAIL_CHANGE' || t.usedAt || t.expiresAt <= new Date() || !t.newEmail) throw invalid();
  const newEmail = t.newEmail;

  await withTx(async (tx) => {
    const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw invalid();
    if (await tx.user.findUnique({ where: { email: newEmail }, select: { id: true } })) throw invalid(); // taken in the meantime
    const oldEmail = t.user.email;
    await tx.user.update({ where: { id: t.userId }, data: { email: newEmail, emailVerifiedAt: new Date() } });
    // A changed identifier invalidates every session; the person signs in again with the new address.
    await revokeUserSessions(tx, t.userId);
    const changedMail = templates.emailChanged(oldEmail, t.user.firstName || t.user.name, newEmail);
    await queueEmail(tx, changedMail);
    await alertInApp(t.userId, changedMail);
    await recordAudit(tx, meta, { action: AuditActions.emailChanged, userId: t.userId, resourceType: 'user', resourceId: t.userId });
  });
}

// ─────────────── sessions ───────────────

export async function listSessions(ctx: UserContext) {
  const rows = await prisma().session.findMany({
    where: { userId: ctx.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  });
  // Raw tokens are never stored or returned; only an opaque id identifies a session.
  return rows.map((s) => {
    const d = describeUserAgent(s.userAgent);
    return {
      id: s.id,
      device: d.label,
      deviceType: d.type,
      browser: d.browser,
      os: d.os,
      ip: s.ip,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      current: s.id === ctx.sessionId,
    };
  });
}

/** Only ever the caller's own session: another person's id behaves exactly like a missing one. */
export async function revokeOwnSession(ctx: UserContext, sessionId: string) {
  parseOrThrow(uuidSchema, sessionId);
  await withTx(async (tx) => {
    const res = await tx.session.updateMany({ where: { id: sessionId, userId: ctx.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count !== 1) throw Errors.notFound('Session');
    await recordAudit(tx, ctx.meta, { action: AuditActions.sessionRevoked, userId: ctx.user.id, metadata: { sessionId, current: sessionId === ctx.sessionId } });
  });
}

export async function revokeOtherSessions(ctx: UserContext) {
  return withTx(async (tx) => {
    const n = await revokeUserSessions(tx, ctx.user.id, ctx.sessionId);
    await recordAudit(tx, ctx.meta, { action: AuditActions.sessionsRevoked, userId: ctx.user.id, metadata: { count: n } });
    return { revoked: n };
  });
}

// ─────────────── deactivation ───────────────

export const deactivateSchema = reauthSchema;

/**
 * Deactivate the personal account. History in every business is kept (nothing is
 * deleted); the person simply can no longer sign in. Blocked while they are the
 * Owner of an active business — transfer or close it first.
 */
export async function deactivateAccount(ctx: UserContext, input: unknown) {
  const data = parseOrThrow(deactivateSchema, input);
  const owned = await prisma().membership.findFirst({
    where: { userId: ctx.user.id, status: 'ACTIVE', isOwner: true, business: { status: 'ACTIVE' } },
    include: { business: { select: { name: true } } },
  });
  if (owned) throw Errors.conflict(`You are the Owner of ${owned.business.name}. Transfer ownership or close the business before deactivating your account.`);
  await verifyReauth(ctx, data);
  const user = await prisma().user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  await withTx(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { status: 'DEACTIVATED', deactivatedAt: new Date() } });
    await revokeUserSessions(tx, user.id);
    // Seats are released; the membership rows (and everything the person did) stay.
    await tx.membership.updateMany({ where: { userId: user.id, status: 'ACTIVE' }, data: { status: 'SUSPENDED' } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.accountDeactivated, userId: user.id, resourceType: 'user', resourceId: user.id });
    await emailUser(tx, user, 'security', (to, name) => templates.accountDeactivated(to, user.firstName || name));
  });
}

// ─────────────── my security activity ───────────────

export const securityEventsSchema = paginationSchema;

/** The person's own account-level events (sign-ins, password, MFA, email, sessions). */
export async function listMySecurityEvents(ctx: UserContext, query: unknown) {
  const q = parseOrThrow(securityEventsSchema, query);
  return withUser(ctx.user.id, async (tx) => {
    const where = { userId: ctx.user.id, businessId: null };
    const [total, rows] = await seq([
      tx.auditLog.count({ where }),
      tx.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return {
      items: rows.map((r) => ({ id: r.id, action: r.action, ip: r.ip, device: describeUserAgent(r.userAgent).label, createdAt: r.createdAt })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}
