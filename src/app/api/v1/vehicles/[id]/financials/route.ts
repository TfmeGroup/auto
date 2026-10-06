import { ok, route } from '@/server/http/route';
import { getVehicleFinancials } from '@/server/finance/insights';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ["invoice.view","quote.view"] }, async ({ ctx, params }) => {
  return ok(await getVehicleFinancials(ctx, params.id ?? ''));
});
