import { ok, readBody, route } from '@/server/http/route';
import { getNotificationSettings, setNotificationPreferences } from '@/server/account/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'user' }, async ({ ctx }) => ok(await getNotificationSettings(ctx.user.id)));

export const PUT = route({ access: 'user' }, async ({ req, ctx }) => {
  await setNotificationPreferences(ctx, await readBody(req));
  return ok(await getNotificationSettings(ctx.user.id));
});
