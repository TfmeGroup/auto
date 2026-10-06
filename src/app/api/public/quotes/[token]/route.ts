import { ok, route } from '@/server/http/route';
import { getPublicQuote } from '@/server/finance/quote-public';

export const dynamic = 'force-dynamic';

/** A customer opens their quote link. No sign-in: the secret in the link is the credential. */
export const GET = route({ access: 'public', rateLimit: { name: 'public-quote', limit: 60, windowSec: 60, by: 'ip' } }, async ({ params, meta }) =>
  ok(await getPublicQuote(params.token ?? '', meta)),
);
