import { ok, readBody, route } from '@/server/http/route';
import { getConfig, updateLabourRules } from '@/server/settings/config-service';

export const dynamic = 'force-dynamic';

const view = (c: Awaited<ReturnType<typeof getConfig>>) => ({ minBillableMinutes: c.minBillableMinutes, timeRoundingMinutes: c.timeRoundingMinutes, timeRoundingMode: c.timeRoundingMode });

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(view(await getConfig(ctx))));
export const PATCH = route({ access: 'business', permission: 'labour.manage_rates', write: true, feature: 'advanced_settings' }, async ({ req, ctx }) => ok(view(await updateLabourRules(ctx, await readBody(req)))));
