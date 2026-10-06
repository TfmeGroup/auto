import { ok, readBody, route } from '@/server/http/route';
import { setVehicleStatus } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await setVehicleStatus(ctx, params.id ?? '', await readBody(req))),
);
