import { ok, readBody, route } from '@/server/http/route';
import { decideQuotePublic } from '@/server/finance/quote-public';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'public', rateLimit: { name: 'public-quote-decision', limit: 20, windowSec: 60, by: 'ip' } }, async ({ req, params, meta }) =>
  ok(await decideQuotePublic(params.token ?? '', await readBody(req), meta)),
);
