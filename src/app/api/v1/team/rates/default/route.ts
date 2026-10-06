import { ok, readBody, route } from '@/server/http/route';
import { setDefaultLabourRate } from '@/server/team/labour';

export const dynamic = 'force-dynamic';

export const PUT = route({ access: 'business', permission: 'labour.manage_rates', write: true }, async ({ req, ctx }) => {
  return ok(await setDefaultLabourRate(ctx, await readBody(req)));
});
