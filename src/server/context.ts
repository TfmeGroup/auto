import type { Permission } from '@/server/permissions/catalog';
import type { EffectiveSubscription } from '@/server/billing/subscriptions';

/** Per-request metadata attached to audit events. */
export interface RequestMeta {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

/** An authenticated person (no business selected yet). */
export interface UserContext {
  meta: RequestMeta;
  sessionId: string;
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    mfaEnabled: boolean;
  };
}

/** An authenticated person acting inside one business with resolved permissions. */
export interface BusinessContext extends UserContext {
  business: {
    id: string;
    name: string;
    vatRegistered: boolean;
    vatRateBps: number;
    currency: string;
    timezone: string;
    locale: string;
    requireMfa: boolean;
  };
  membership: {
    id: string;
    roleId: string;
    roleKey: string;
    roleName: string;
    allLocations: boolean;
  };
  permissions: ReadonlySet<Permission>;
  subscription: EffectiveSubscription;
}

export const systemMeta = (requestId = 'system'): RequestMeta => ({ requestId });
