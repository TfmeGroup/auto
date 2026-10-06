import { ok, readBody, route } from '@/server/http/route';
import { approveQuoteOnBehalf } from '@/server/finance/quotes';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "quote.approve", write: true }, async ({ req, ctx, params }) => {
  return ok(await approveQuoteOnBehalf(ctx, params.id ?? '', await readBody(req)));
});
