import { ok, rawQuery, route } from '@/server/http/route';
import { usageReport } from '@/server/inventory/reports';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  return ok(await usageReport(ctx, rawQuery(req)));
});
