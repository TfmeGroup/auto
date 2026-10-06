import { ok, rawQuery, readBody, route } from '@/server/http/route';
import { getQuote, updateQuote } from '@/server/finance/quotes';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "quote.view" }, async ({ req, ctx, params }) => {
  return ok(await getQuote(ctx, params.id ?? '', rawQuery(req)));
});

export const PATCH = route({ access: 'business', permission: "quote.edit", write: true }, async ({ req, ctx, params }) => {
  return ok(await updateQuote(ctx, params.id ?? '', await readBody(req)));
});
