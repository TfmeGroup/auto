import { ok, readBody, route } from '@/server/http/route';
import { applyCredit } from '@/server/finance/payments';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "payment.apply_credit", write: true }, async ({ req, ctx, params }) => {
  return ok(await applyCredit(ctx, params.id ?? '', await readBody(req)));
});
