import { ok, rawQuery, route } from '@/server/http/route';
import { getTeamWorkload } from '@/server/team/performance';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'employee.view_reports', feature: 'technician_management' }, async ({ req, ctx }) => {
  return ok(await getTeamWorkload(ctx, rawQuery(req)));
});
