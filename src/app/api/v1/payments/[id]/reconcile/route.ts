import { ok, readBody, route } from '@/server/http/route';
import { reconcilePayment } from '@/server/finance/payments';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "payment.reconcile", write: true }, async ({ req, ctx, params }) => {
  return ok(await reconcilePayment(ctx, params.id ?? '', await readBody(req)));
});
