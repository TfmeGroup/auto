import { ok, readBody, route } from '@/server/http/route';
import { getBusiness, updateBusiness } from '@/server/businesses/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['business.view', 'settings.view'] }, async ({ ctx }) => ok(await getBusiness(ctx)));

export const PATCH = route({ access: 'business', permission: 'business.edit', write: true }, async ({ req, ctx }) =>
  ok(await updateBusiness(ctx, await readBody(req))),
);
