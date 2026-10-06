import { ok, readBody, route } from '@/server/http/route';
import { getInventorySettings, updateInventorySettings } from '@/server/inventory/settings';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ ctx }) => {
  return ok(await getInventorySettings(ctx));
});

export const PATCH = route({ access: 'business', permission: 'inventory.manage_settings', write: true }, async ({ req, ctx }) => {
  await updateInventorySettings(ctx, await readBody(req)); return ok(await getInventorySettings(ctx));
});
