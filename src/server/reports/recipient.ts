import { prisma } from '@/server/db/client';
import { loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { isPermission, type Permission } from '@/server/permissions/catalog';
import { systemMeta, type BusinessContext } from '@/server/context';

/**
 * The context a person would have if they opened the app right now, built without a browser session. Scheduled reports are generated
 * once PER RECIPIENT with the recipient's own permissions, location access and plan, so a report can never carry more than the person
 * receiving it could see themselves. Returns null if the person is no longer an active member.
 */
export async function contextForMembership(businessId: string, membershipId: string): Promise<BusinessContext | null> {
  const m = await prisma().membership.findFirst({
    where: { id: membershipId, businessId, status: 'ACTIVE', userId: { not: null }, business: { status: 'ACTIVE' } },
    include: { business: true, role: { include: { permissions: true } }, user: true },
  });
  if (!m || !m.user) return null;
  const b = m.business;
  return {
    meta: systemMeta('report'),
    sessionId: 'system',
    user: { id: m.user.id, email: m.user.email, name: m.user.name, emailVerified: m.user.emailVerifiedAt !== null, mfaEnabled: m.user.mfaEnabled },
    business: { id: b.id, name: b.name, vatRegistered: b.vatRegistered, vatRateBps: b.vatRateBps, currency: b.currency, timezone: b.timezone, locale: b.locale, requireMfa: b.requireMfa },
    membership: { id: m.id, roleId: m.roleId, roleKey: m.role.key, roleName: m.role.name, allLocations: m.allLocations },
    permissions: new Set<Permission>(m.role.permissions.map((p) => p.permission).filter(isPermission)),
    subscription: await loadEffectiveSubscription(prisma(), b.id),
  };
}
