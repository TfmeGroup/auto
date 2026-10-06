import { ok, readBody, route } from '@/server/http/route';
import { setServiceTypeRate } from '@/server/team/labour';

export const dynamic = 'force-dynamic';

export const PUT = route({ access: 'business', permission: 'labour.manage_rates', write: true }, async ({ req, ctx, params }) => {
  return ok(await setServiceTypeRate(ctx, params.id ?? '', await readBody(req)));
});
