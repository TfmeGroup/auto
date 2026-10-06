import { created, readBody, route } from '@/server/http/route';
import { addVehicleContact } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ req, ctx, params }) =>
  created(await addVehicleContact(ctx, params.id ?? '', await readBody(req))),
);
