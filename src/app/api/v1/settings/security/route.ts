import { ok, readBody, route } from '@/server/http/route';
import { getSecuritySettings, updateSecuritySettings } from '@/server/settings/config-service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await getSecuritySettings(ctx)));
export const PATCH = route({ access: 'business', permission: 'settings.manage_security', write: true }, async ({ req, ctx }) => {
  await updateSecuritySettings(ctx, await readBody(req));
  return ok(await getSecuritySettings(ctx));
});
