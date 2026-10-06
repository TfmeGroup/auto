import { seq, withTenant, type Tx } from '@/server/db/client';
import { countSeats, type PlanLimits } from '@/server/billing/subscriptions';
import type { BusinessContext } from '@/server/context';

/**
 * The single, authoritative answer to "how much of the plan is this business using?".
 * Billing screens, downgrade checks and limit enforcement all read from here, so the
 * numbers can never disagree. Add a metered resource here once and every consumer gets it.
 */
export interface Usage {
  members: { used: number; limit: number };
  locations: { used: number; limit: number };
  storage: { usedBytes: number; limitBytes: number };
}

export interface UsageNumbers {
  members: number;
  locations: number;
  storageBytes: number;
}

/** Raw usage. Run inside withTenant() (files/locations are tenant tables). */
export async function measureUsage(tx: Tx, businessId: string): Promise<UsageNumbers> {
  const members = await countSeats(tx, businessId);
  const [locations, files] = await seq([
    tx.location.count({ where: { businessId, status: 'ACTIVE' } }),
    tx.file.aggregate({ where: { businessId, status: { in: ['ACTIVE', 'ARCHIVED', 'TRASHED'] } }, _sum: { sizeBytes: true } }),
  ]);
  return { members, locations, storageBytes: files._sum.sizeBytes ?? 0 };
}

export const withLimits = (n: UsageNumbers, limits: PlanLimits): Usage => ({
  members: { used: n.members, limit: limits.members },
  locations: { used: n.locations, limit: limits.locations },
  storage: { usedBytes: n.storageBytes, limitBytes: limits.storageMb * 1024 * 1024 },
});

export async function getUsage(ctx: BusinessContext): Promise<Usage> {
  const n = await withTenant(ctx.business.id, (tx) => measureUsage(tx, ctx.business.id));
  return withLimits(n, ctx.subscription.limits);
}
