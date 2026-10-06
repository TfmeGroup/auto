import { ok, route } from '@/server/http/route';
import { getCustomerCredit } from '@/server/finance/payments';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ["payment.view","invoice.view"] }, async ({ ctx, params }) => {
  return ok(await getCustomerCredit(ctx, params.id ?? ''));
});
