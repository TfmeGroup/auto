import { ok, rawQuery, route } from '@/server/http/route';
import { getInventoryDashboard } from '@/server/inventory/reports';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  return ok(await getInventoryDashboard(ctx, rawQuery(req)));
});
