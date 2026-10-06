import { ok, readBody, route } from '@/server/http/route';
import { markIntervalServiced } from '@/server/vehicles/insights';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await markIntervalServiced(ctx, params.id ?? '', params.intervalId ?? '', await readBody(req)).then(() => null)),
);
