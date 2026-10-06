import { ok, readBody, route } from '@/server/http/route';
import { updateServiceType } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'booking.manage', write: true }, async ({ req, ctx, params }) =>
  ok(await updateServiceType(ctx, params.id ?? '', await readBody(req))),
);
