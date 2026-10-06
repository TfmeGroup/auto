import { ok, readBody, route } from '@/server/http/route';
import { getCommSettings, updateCommSettings } from '@/server/notifications/settings';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'notification.manage_settings' }, async ({ ctx }) => ok(await getCommSettings(ctx)));
export const PUT = route({ access: 'business', permission: 'notification.manage_settings', write: true }, async ({ req, ctx }) => ok(await updateCommSettings(ctx, await readBody(req))));
