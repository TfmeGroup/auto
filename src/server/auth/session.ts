import { env } from '@/lib/env';
import { prisma, type Db } from '@/server/db/client';
import { generateToken, hashToken } from '@/server/security/crypto';
import type { RequestMeta } from '@/server/context';

export const SESSION_COOKIE = 'tfme_auto_session';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires,
  };
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
  sessionId: string;
}

/** Create a session. The raw token is returned once (for the cookie); only its hash is stored. */
export async function createSession(
  db: Db,
  userId: string,
  meta: RequestMeta,
  activeBusinessId?: string | null,
): Promise<CreatedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_DAYS * 86_400_000);
  const row = await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      activeBusinessId: activeBusinessId ?? null,
    },
  });
  return { token, expiresAt, sessionId: row.id };
}

export interface ResolvedSession {
  sessionId: string;
  createdAt: Date;
  activeBusinessId: string | null;
  user: { id: string; email: string; name: string; emailVerifiedAt: Date | null; mfaEnabled: boolean; status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' };
}

/** Look up a live session by raw cookie token. Returns null for unknown/expired/revoked/disabled. */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const s = await prisma().session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!s || s.revokedAt || s.expiresAt <= new Date() || s.user.status !== 'ACTIVE') return null;

  if (Date.now() - s.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    // Best-effort sliding "last used" timestamp; failure must not break the request.
    prisma().session.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return {
    sessionId: s.id,
    createdAt: s.createdAt,
    activeBusinessId: s.activeBusinessId,
    user: {
      id: s.user.id,
      email: s.user.email,
      name: s.user.name,
      emailVerifiedAt: s.user.emailVerifiedAt,
      mfaEnabled: s.user.mfaEnabled,
      status: s.user.status,
    },
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Revoke every live session of a user, optionally keeping one (the current one). */
export async function revokeUserSessions(db: Db, userId: string, exceptSessionId?: string): Promise<number> {
  const res = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

export async function setActiveBusiness(db: Db, sessionId: string, businessId: string | null): Promise<void> {
  await db.session.update({ where: { id: sessionId }, data: { activeBusinessId: businessId } });
}
