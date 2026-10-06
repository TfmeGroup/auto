import { withTenant } from '@/server/db/client';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { accessibleLocations } from './common';

/** The locations this person may use for stock (for pickers and filters). */
export async function accessibleLocationsFor(ctx: BusinessContext) {
  requirePermission(ctx, 'inventory.view');
  return withTenant(ctx.business.id, (tx) => accessibleLocations(tx, ctx));
}
