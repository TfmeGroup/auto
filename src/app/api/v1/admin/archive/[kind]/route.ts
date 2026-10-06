import { ok, rawQuery, route } from '@/server/http/route';
import { listArchived } from '@/server/admin/archive';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'admin.view', feature: 'advanced_admin' }, async ({ req, ctx, params }) => {
  const r = await listArchived(ctx, params.kind ?? '', rawQuery(req));
  return ok(r.items, r.meta);
});
