import { ok, readBody, route } from '@/server/http/route';
import { correctMileage } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'vehicle.correct_mileage', write: true }, async ({ req, ctx, params }) =>
  ok(await correctMileage(ctx, params.id ?? '', await readBody(req))),
);
