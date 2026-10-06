import { ok, route } from '@/server/http/route';
import { getVehicleOverview } from '@/server/vehicles/insights';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'vehicle.view' }, async ({ ctx, params }) =>
  ok(await getVehicleOverview(ctx, params.id ?? '')),
);
