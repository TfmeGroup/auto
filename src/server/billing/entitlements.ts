import type { BusinessContext } from '@/server/context';
import { getUsage, type Usage } from '@/server/usage/service';
import { ALL_FEATURES, FEATURES, type FeatureKey } from './features';

/**
 * The one place that answers "what may this business do on its plan, right now?".
 * It reads the live subscription (plan features, limits, status) and live usage, so screens, APIs and tests
 * all see the same answer. It never changes anything: enforcement happens in the services (requireFeature,
 * assertWithinLimit, assertCanWrite), which call the same underlying data.
 */
export interface OverLimit {
  kind: 'members' | 'locations' | 'storage';
  label: string;
  used: number;
  limit: number;
}

/** Resources used beyond the plan's limit (possible after a downgrade or a contract change). Nothing is deleted; creating more is refused. */
export function overLimitOf(u: Usage): OverLimit[] {
  const out: OverLimit[] = [];
  if (u.members.used > u.members.limit) out.push({ kind: 'members', label: 'Team members', used: u.members.used, limit: u.members.limit });
  if (u.locations.used > u.locations.limit) out.push({ kind: 'locations', label: 'Locations', used: u.locations.used, limit: u.locations.limit });
  if (u.storage.usedBytes > u.storage.limitBytes) out.push({ kind: 'storage', label: 'Storage (bytes)', used: u.storage.usedBytes, limit: u.storage.limitBytes });
  return out;
}

export async function getEntitlements(ctx: BusinessContext) {
  const s = ctx.subscription;
  const usage = await getUsage(ctx);
  const has = (k: FeatureKey) => s.features.has(k);
  const w = s.canWrite;
  return {
    plan: { key: s.planKey, name: s.planName, isCustom: s.isCustom },
    status: s.status,
    canWrite: w,
    limits: { members: s.limits.members, locations: s.limits.locations, storageMb: s.limits.storageMb },
    usage,
    remaining: {
      members: Math.max(0, usage.members.limit - usage.members.used),
      locations: Math.max(0, usage.locations.limit - usage.locations.used),
      storageBytes: Math.max(0, usage.storage.limitBytes - usage.storage.usedBytes),
    },
    overLimit: overLimitOf(usage),
    features: ALL_FEATURES.map((key) => ({ key, label: FEATURES[key], included: has(key) })),
    can: {
      inviteMember: w && usage.members.used < usage.members.limit,
      // The first location is on every plan; more need the multi-location feature and room.
      createLocation: w && usage.locations.used < usage.locations.limit && (usage.locations.used < 1 || has('multi_location')),
      createCustomRole: w && has('custom_roles'),
      createCustomReport: w && has('custom_reports'),
      scheduleReports: w && has('scheduled_reports'),
      useOnlinePayments: w && has('online_payments'),
      useSms: has('sms_notifications'),
      useWhatsApp: has('whatsapp_notifications'),
      usePurchaseOrders: w && has('purchase_orders'),
      transferStock: w && has('multi_location'),
      uploadFiles: w && usage.storage.usedBytes < usage.storage.limitBytes,
      exportData: has('data_export'),
    },
  };
}
