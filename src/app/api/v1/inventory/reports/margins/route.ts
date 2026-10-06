import { ok, rawQuery, route } from '@/server/http/route';
import { marginReport } from '@/server/inventory/reports';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view_costs', feature: 'inventory_reports' }, async ({ req, ctx }) => {
  return ok(await marginReport(ctx, rawQuery(req)));
});
