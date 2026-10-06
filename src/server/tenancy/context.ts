import { prisma, withTenant } from '@/server/db/client';
import { sessionLimitHours } from '@/server/settings/config';
import { Errors } from '@/lib/errors';
import { resolveSession, setActiveBusiness } from '@/server/auth/session';
import { loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { isPermission, type Permission } from '@/server/permissions/catalog';
import type { BusinessContext, RequestMeta, UserContext } from '@/server/context';

export interface AuthState {
  user: UserContext;
  activeBusinessId: string | null;
  /** When this sign-in began (a business may limit how long one sign-in may last). */
  sessionCreatedAt?: Date;
}

/** Cookie token -> authenticated user, or null. No business is resolved here. */
export async function authenticate(token: string | undefined, meta: RequestMeta): Promise<AuthState | null> {
  const s = await resolveSession(token);
  if (!s) return null;
  return {
    activeBusinessId: s.activeBusinessId,
    sessionCreatedAt: s.createdAt,
    user: {
      meta,
      sessionId: s.sessionId,
      user: {
        id: s.user.id,
        email: s.user.email,
        name: s.user.name,
        emailVerified: s.user.emailVerifiedAt !== null,
        mfaEnabled: s.user.mfaEnabled,
      },
    },
  };
}

/**
 * Resolve the business the user is currently acting in and their permissions.
 *
 * The business is NEVER taken from the client. It comes from the server-side
 * session and is re-validated against an ACTIVE membership on every request, so
 * a suspended or removed member loses access immediately.
 */
export async function resolveBusinessContext(auth: AuthState): Promise<BusinessContext> {
  const { user, activeBusinessId } = auth;

  const load = (businessId: string) =>
    prisma().membership.findFirst({
      where: { userId: user.user.id, businessId, status: 'ACTIVE', business: { status: 'ACTIVE' } },
      include: { business: true, role: { include: { permissions: true } } },
    });

  let membership = activeBusinessId ? await load(activeBusinessId) : null;

  if (!membership) {
    // Active business is unset or no longer valid: fall back to any other active membership.
    const other = await prisma().membership.findFirst({
      where: { userId: user.user.id, status: 'ACTIVE', business: { status: 'ACTIVE' } },
      orderBy: { joinedAt: 'asc' },
      select: { businessId: true },
    });
    if (!other) throw Errors.noBusiness();
    membership = await load(other.businessId);
    if (!membership) throw Errors.noBusiness();
    await setActiveBusiness(prisma(), user.sessionId, membership.businessId);
  }

  const permissions = new Set<Permission>(
    membership.role.permissions.map((p) => p.permission).filter(isPermission),
  );
  const b = membership.business;

  // A business may limit how long one sign-in lasts (Settings, Security). Past the limit the person signs in again; nothing else changes.
  if (auth.sessionCreatedAt) {
    const limit = await withTenant(b.id, (tx) => sessionLimitHours(tx, b.id));
    if (limit && Date.now() - auth.sessionCreatedAt.getTime() > limit * 3_600_000) {
      throw Errors.unauthenticated('This business limits how long you can stay signed in. Please sign in again.');
    }
  }

  return {
    ...user,
    business: {
      id: b.id,
      name: b.name,
      vatRegistered: b.vatRegistered,
      vatRateBps: b.vatRateBps,
      currency: b.currency,
      timezone: b.timezone,
      locale: b.locale,
      requireMfa: b.requireMfa,
    },
    membership: {
      id: membership.id,
      roleId: membership.roleId,
      roleKey: membership.role.key,
      roleName: membership.role.name,
      allLocations: membership.allLocations,
    },
    permissions,
    subscription: await loadEffectiveSubscription(prisma(), b.id),
  };
}
