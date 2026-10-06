import { ok, readBody, route } from '@/server/http/route';
import { sendQuote } from '@/server/finance/quotes';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "quote.send", write: true }, async ({ req, ctx, params }) => {
  return ok(await sendQuote(ctx, params.id ?? '', await readBody(req)));
});
