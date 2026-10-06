import { ok, rawQuery, route } from '@/server/http/route';
import { listServiceHistory } from '@/server/vehicles/insights';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['vehicle.view'] }, async ({ req, ctx, params }) => {
  const r = await listServiceHistory(ctx, params.id ?? '', rawQuery(req)); return ok(r.items, r.meta);
});
