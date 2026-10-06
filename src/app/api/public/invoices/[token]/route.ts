import { ok, route } from '@/server/http/route';
import { getPublicInvoice } from '@/server/finance/online';

export const dynamic = 'force-dynamic';

/** A customer opens their invoice link. No sign-in: the secret in the link is the credential. */
export const GET = route({ access: 'public', rateLimit: { name: 'public-invoice', limit: 60, windowSec: 60, by: 'ip' } }, async ({ params, meta }) =>
  ok(await getPublicInvoice(params.token ?? '', meta)),
);
