import { created, ok, readBody, route } from '@/server/http/route';
import { listIntervals, addInterval } from '@/server/vehicles/insights';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'vehicle.view' }, async ({ ctx, params }) =>
  ok(await listIntervals(ctx, params.id ?? '')),
);

export const POST = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ req, ctx, params }) =>
  created(await addInterval(ctx, params.id ?? '', await readBody(req))),
);
