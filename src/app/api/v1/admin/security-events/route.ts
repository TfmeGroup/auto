import { ok, rawQuery, route } from '@/server/http/route';
import { listSecurityEvents } from '@/server/admin/audit';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'security.view_events', feature: 'advanced_admin' }, async ({ req, ctx }) => {
  const r = await listSecurityEvents(ctx, rawQuery(req));
  return ok(r.items, r.meta);
});
