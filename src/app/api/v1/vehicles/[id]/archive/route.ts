import { ok, readBody, route } from '@/server/http/route';
import { setVehicleArchived } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'vehicle.archive', write: true }, async ({ req, ctx, params }) =>
  ok(await setVehicleArchived(ctx, params.id ?? '', !!(await readBody(req) as { archived?: boolean }).archived)),
);
