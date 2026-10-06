import { ok, readBody, route } from '@/server/http/route';
import { bulkUpdateParts } from '@/server/inventory/import';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.edit', write: true, feature: 'bulk_inventory' }, async ({ req, ctx }) => {
  return ok(await bulkUpdateParts(ctx, await readBody(req)));
});
