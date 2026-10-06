import { ok, rawQuery, route } from '@/server/http/route';
import { listTimeline } from '@/server/activity/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'vehicle.view' }, async ({ req, ctx, params }) => {
  const r = await listTimeline(ctx, { vehicleId: params.id ?? '' }, rawQuery(req)); return ok(r.items, r.meta);
});
