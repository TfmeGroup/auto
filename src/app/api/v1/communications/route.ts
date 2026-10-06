import { ok, rawQuery, route } from '@/server/http/route';
import { listCommunications } from '@/server/notifications/history';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'notification.view_history', feature: 'communication_history' }, async ({ req, ctx }) => {
  const r = await listCommunications(ctx, rawQuery(req));
  return ok(r.items, r.meta);
});
