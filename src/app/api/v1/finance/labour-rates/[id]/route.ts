import { ok, readBody, route } from '@/server/http/route';
import { setLabourCostRate } from '@/server/finance/settings';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: "finance.manage_settings", write: true }, async ({ req, ctx, params }) => {
  return ok(await setLabourCostRate(ctx, params.id ?? '', await readBody(req)));
});
