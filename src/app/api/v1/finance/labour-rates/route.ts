import { ok, route } from '@/server/http/route';
import { listLabourCostRates } from '@/server/finance/settings';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "finance.manage_settings" }, async ({ ctx }) => {
  return ok(await listLabourCostRates(ctx));
});
