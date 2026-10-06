import { env } from '@/lib/env';
import { prisma, withTenant } from '@/server/db/client';
import { can, requirePermission } from '@/server/permissions/authorize';
import { getStorageReport } from '@/server/files/usage';
import { measureUsage } from '@/server/usage/service';
import type { BusinessContext } from '@/server/context';
import { getAlerts } from './alerts';
import { getSetupCheck } from './setup';

/**
 * The Administration landing page. Each block appears only if the caller may act on it, and nothing here is platform-level: no other
 * business, no platform settings, no secrets (the email and payment lines say whether something is connected, never how).
 */
export async function getAdminOverview(ctx: BusinessContext) {
  requirePermission(ctx, 'admin.view');
  const bid = ctx.business.id;
  const sub = ctx.subscription;
  const [setup, alerts, data] = [
    can(ctx, 'settings.view') ? await getSetupCheck(ctx) : null,
    await getAlerts(ctx),
    await withTenant(bid, async (tx) => {
      const [business, usage, finance, week] = [
        await tx.business.findUniqueOrThrow({ where: { id: bid }, select: { name: true, tradingName: true, status: true, vatRegistered: true, timezone: true, currency: true, logoFileId: true } }),
        await measureUsage(tx, bid), await tx.financeSettings.findUnique({ where: { businessId: bid }, select: { onlineProvider: true } }), new Date(Date.now() - 7 * 86_400_000),
      ];
      const recent = can(ctx, 'audit.view') ? await tx.auditLog.findMany({ where: { businessId: bid }, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, action: true, userId: true, createdAt: true } }) : null;
      const names = recent?.length ? new Map((await tx.user.findMany({ where: { id: { in: recent.map((r) => r.userId).filter((v): v is string => !!v) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])) : new Map<string, string>();
      const failedMessages = can(ctx, 'notification.view_history') ? await tx.communication.count({ where: { businessId: bid, status: 'FAILED', createdAt: { gte: week } } }) : null;
      return { business, usage, finance, recent: recent?.map((r) => ({ ...r, user: r.userId ? (names.get(r.userId) ?? 'Unknown user') : 'System' })) ?? null, failedMessages };
    }),
  ];
  const invited = can(ctx, 'employee.view') ? await prisma().membership.count({ where: { businessId: bid, status: 'INVITED' } }) : null;
  const storage = can(ctx, 'document.view') ? await getStorageReport(ctx).catch(() => null) : null;
  return {
    business: { name: data.business.tradingName ?? data.business.name, status: data.business.status, vatRegistered: data.business.vatRegistered, timezone: data.business.timezone, currency: data.business.currency, hasLogo: !!data.business.logoFileId },
    subscription: { plan: sub.planName, status: sub.status, trialDaysRemaining: sub.trialDaysRemaining, renewsAt: sub.currentPeriodEnd, canWrite: sub.canWrite },
    usage: { members: { used: data.usage.members, limit: sub.limits.members, invited }, locations: { used: data.usage.locations, limit: sub.limits.locations }, storage: { usedBytes: data.usage.storageBytes, limitBytes: sub.limits.storageMb * 1024 * 1024, percent: storage?.percentUsed ?? null } },
    setup: setup ? { complete: setup.complete, warnings: setup.warnings, actionRequired: setup.actionRequired, total: setup.items.length } : null,
    alerts,
    recentActivity: data.recent,
    integrations: {
      email: env().EMAIL_DRIVER === 'smtp' ? 'connected' : 'not connected',
      onlinePayments: data.finance?.onlineProvider ? 'configured' : 'not set up',
      failedMessagesLast7Days: data.failedMessages,
    },
    can: {
      security: can(ctx, 'security.view_events') && sub.features.has('advanced_admin'), archive: sub.features.has('advanced_admin'), import: can(ctx, 'data.import'), export: can(ctx, 'business.export'), audit: can(ctx, 'audit.view'),
      settings: can(ctx, 'settings.view'), search: sub.features.has('advanced_admin'),
    },
  };
}
