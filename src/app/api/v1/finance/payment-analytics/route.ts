import { ok, rawQuery, route } from '@/server/http/route';
import { getPaymentAnalytics } from '@/server/finance/reports';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "finance.view_reports" }, async ({ req, ctx }) => {
  return ok(await getPaymentAnalytics(ctx, rawQuery(req)));
});
