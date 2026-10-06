import { ok, readBody, route } from '@/server/http/route';
import { getVehicleConfig, updateVehicleConfig } from '@/server/settings/config-service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await getVehicleConfig(ctx)));
export const PATCH = route({ access: 'business', permission: 'settings.manage_workshop', write: true, feature: 'advanced_settings' }, async ({ req, ctx }) => {
  await updateVehicleConfig(ctx, await readBody(req));
  return ok(await getVehicleConfig(ctx));
});
