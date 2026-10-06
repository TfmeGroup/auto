import { ok, route } from '@/server/http/route';
import { getPayment } from '@/server/finance/payments';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "payment.view" }, async ({ ctx, params }) => {
  return ok(await getPayment(ctx, params.id ?? ''));
});
