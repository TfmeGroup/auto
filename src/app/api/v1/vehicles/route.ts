import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listVehicles, createVehicle } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'vehicle.view' }, async ({ req, ctx }) => {
  const r = await listVehicles(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'vehicle.create', write: true }, async ({ req, ctx }) =>
  created(await createVehicle(ctx, await readBody(req))),
);
