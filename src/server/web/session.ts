import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE } from '@/server/auth/session';
import { authenticate, resolveBusinessContext, type AuthState } from '@/server/tenancy/context';
import { AppError } from '@/lib/errors';
import type { BusinessContext, UserContext } from '@/server/context';

/**
 * Session access for server components/pages. Pages call these instead of
 * reading cookies themselves, so every page gets the same checks as the API.
 * `cache()` de-duplicates the lookup within one render.
 */

const loadAuth = cache(async (): Promise<AuthState | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const h = await headers();
  return authenticate(token, { requestId: randomUUID(), userAgent: h.get('user-agent') ?? undefined });
});

export async function getUser(): Promise<UserContext | null> {
  return (await loadAuth())?.user ?? null;
}

export async function requireUser(): Promise<UserContext> {
  const u = await getUser();
  if (!u) redirect('/login');
  return u;
}

/** Signed in AND acting in a business; otherwise sends the user where they can fix that. */
export async function requireBusiness(): Promise<BusinessContext> {
  const auth = await loadAuth();
  if (!auth) redirect('/login');
  try {
    const ctx = await resolveBusinessContext(auth);
    // Same rule as the API: a business that requires MFA is closed to members without it until they enable it.
    if (ctx.business.requireMfa && !ctx.user.mfaEnabled) redirect('/account/security?mfa=required');
    return ctx;
  } catch (e) {
    if (e instanceof AppError && e.code === 'NO_BUSINESS') redirect('/onboarding');
    throw e;
  }
}

/** Page-level permission gate: shows the standard "not allowed" page instead of leaking content. */
export function assertCan(ctx: BusinessContext, permission: Parameters<BusinessContext['permissions']['has']>[0]) {
  if (!ctx.permissions.has(permission)) redirect('/forbidden');
}
