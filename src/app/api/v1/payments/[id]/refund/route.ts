import { ok, readBody, route } from '@/server/http/route';
import { refundPayment } from '@/server/finance/payments';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "payment.refund", write: true }, async ({ req, ctx, params }) => {
  return ok(await refundPayment(ctx, params.id ?? '', await readBody(req)));
});
