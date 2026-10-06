import { ok, route } from '@/server/http/route';
import { getCustomerFinancials } from '@/server/finance/insights';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ["invoice.view","quote.view","payment.view"] }, async ({ ctx, params }) => {
  return ok(await getCustomerFinancials(ctx, params.id ?? ''));
});
