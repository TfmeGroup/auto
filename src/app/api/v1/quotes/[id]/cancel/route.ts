import { ok, readBody, route } from '@/server/http/route';
import { cancelQuote } from '@/server/finance/quotes';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "quote.cancel", write: true }, async ({ req, ctx, params }) => {
  return ok(await cancelQuote(ctx, params.id ?? '', await readBody(req)));
});
