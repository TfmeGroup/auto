import { ok, readBody, route } from '@/server/http/route';
import { getInventoryDefaults, updateInventoryDefaults } from '@/server/settings/config-service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await getInventoryDefaults(ctx)));
export const PATCH = route({ access: 'business', permission: 'inventory.manage_settings', write: true }, async ({ req, ctx }) => {
  await updateInventoryDefaults(ctx, await readBody(req));
  return ok(await getInventoryDefaults(ctx));
});
