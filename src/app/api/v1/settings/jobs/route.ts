import { ok, readBody, route } from '@/server/http/route';
import { getJobConfig, updateJobConfig } from '@/server/settings/config-service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await getJobConfig(ctx)));
export const PATCH = route({ access: 'business', permission: 'settings.manage_workshop', write: true, feature: 'advanced_settings' }, async ({ req, ctx }) => {
  await updateJobConfig(ctx, await readBody(req));
  return ok(await getJobConfig(ctx));
});
