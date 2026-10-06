import { ok, rawQuery, readBody, route } from '@/server/http/route';
import { listMileage, recordMileage } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'vehicle.view' }, async ({ req, ctx, params }) => {
  const r = await listMileage(ctx, params.id ?? '', rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await recordMileage(ctx, params.id ?? '', await readBody(req))),
);
