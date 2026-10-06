import { ok, rawQuery, route } from '@/server/http/route';
import { getTechnicianMetrics } from '@/server/team/performance';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: null, feature: 'technician_management' }, async ({ req, ctx, params }) => {
  return ok(await getTechnicianMetrics(ctx, params.id ?? '', rawQuery(req)));
});
