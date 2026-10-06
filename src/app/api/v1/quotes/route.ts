import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listQuotes, createQuote } from '@/server/finance/quotes';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "quote.view" }, async ({ req, ctx }) => {
  const r = await listQuotes(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: "quote.create", write: true }, async ({ req, ctx }) => {
  return created(await createQuote(ctx, await readBody(req)));
});
