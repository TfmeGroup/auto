import { ok, readBody, route } from '@/server/http/route';
import { getReportingSettings, updateReportingSettings } from '@/server/settings/config-service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await getReportingSettings(ctx)));
export const PATCH = route({ access: 'business', permission: 'settings.edit', write: true }, async ({ req, ctx }) => {
  await updateReportingSettings(ctx, await readBody(req));
  return ok(await getReportingSettings(ctx));
});
