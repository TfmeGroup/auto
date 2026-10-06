import { ok, readBody, route } from '@/server/http/route';
import { getVehicle, updateVehicle } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'vehicle.view' }, async ({ ctx, params }) =>
  ok(await getVehicle(ctx, params.id ?? '')),
);

export const PATCH = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await updateVehicle(ctx, params.id ?? '', await readBody(req))),
);
