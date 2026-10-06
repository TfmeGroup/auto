import { z } from 'zod';
import { prisma, withTx, setTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { CUSTOM_PLAN_KEY } from '@/server/billing/plans';
import type { UserContext } from '@/server/context';

/**
 * TFME PLATFORM administration — a different world from a customer's business administration.
 *
 * Nothing here is reachable through a business membership, role or permission: access is a row in
 * `platform_admins` (granted only with owner-level tooling: `npm run platform -- grant <email>`),
 * and the person must have MFA on. A business Owner has no more standing here than anyone else.
 * Every platform action is attributed and audited against the affected business.
 */
export async function requirePlatformAdmin(ctx: UserContext): Promise<void> {
  const row = await prisma().platformAdmin.findUnique({ where: { userId: ctx.user.id } });
  // Same answer whether the area exists or you simply are not allowed in.
  if (!row) throw Errors.notFound('Page');
  if (!ctx.user.mfaEnabled) throw Errors.forbidden('Platform administration requires two-factor authentication.');
}

export const platformBusinessListSchema = paginationSchema.extend({ q: z.string().trim().max(100).optional() });

export async function listBusinessesForPlatform(ctx: UserContext, query: unknown) {
  await requirePlatformAdmin(ctx);
  const q = parseOrThrow(platformBusinessListSchema, query);
  const where = q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {};
  const [total, rows] = await Promise.all([
    prisma().business.count({ where }),
    prisma().business.findMany({ where, include: { subscription: { include: { plan: true } } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  return {
    items: rows.map((b) => ({ id: b.id, name: b.name, status: b.status, createdAt: b.createdAt, plan: b.subscription?.plan.key ?? null, subscriptionStatus: b.subscription?.status ?? null })),
    meta: pageMeta(q.page, q.pageSize, total),
  };
}

export const customPlanSchema = z.object({
  maxMembers: z.number().int().min(36, 'Custom plans start at 36 users'),
  maxLocations: z.number().int().min(1),
  maxStorageMb: z.number().int().min(0),
  /** End of the contracted period (billed outside the self-serve checkout). */
  contractEndsAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), 'Must be in the future'),
  note: z.string().trim().max(500).optional(),
});

/** Put a business on a CUSTOM (36+ users) contract with explicit limits. */
export async function assignCustomPlan(ctx: UserContext, businessId: string, input: unknown) {
  await requirePlatformAdmin(ctx);
  parseOrThrow(uuidSchema, businessId);
  const data = parseOrThrow(customPlanSchema, input);
  return withTx(async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { businessId }, include: { plan: true } });
    if (!sub) throw Errors.notFound('Business');
    const plan = await tx.plan.findUniqueOrThrow({ where: { key: CUSTOM_PLAN_KEY } });
    await setTenant(tx, businessId);
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        planId: plan.id, status: 'ACTIVE', trialEndsAt: null, convertedAt: sub.convertedAt ?? new Date(), pastDueSince: null,
        currentPeriodStart: new Date(), currentPeriodEnd: data.contractEndsAt, cancelAtPeriodEnd: false, pendingPlanId: null, pendingChangeAt: null,
        overrideMaxMembers: data.maxMembers, overrideMaxLocations: data.maxLocations, overrideMaxStorageMb: data.maxStorageMb,
        provider: null, providerSubscriptionRef: null,
      },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.platformCustomPlan, businessId, userId: ctx.user.id, resourceType: 'subscription', resourceId: sub.id,
      before: { plan: sub.plan.key, status: sub.status }, after: { plan: CUSTOM_PLAN_KEY, ...data, contractEndsAt: data.contractEndsAt.toISOString() },
    });
    return { businessId, plan: CUSTOM_PLAN_KEY };
  });
}
