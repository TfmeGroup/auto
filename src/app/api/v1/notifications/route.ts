import { ok, rawQuery, route } from '@/server/http/route';
import { listNotifications } from '@/server/notifications/inapp';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: null }, async ({ req, ctx }) => {
  const r = await listNotifications(ctx, rawQuery(req));
  return ok(r.items, { ...r.meta, unread: r.unread });
});
