import { ok, readBody, route } from '@/server/http/route';
import { startOnlinePayment } from '@/server/finance/online';

export const dynamic = 'force-dynamic';

/** Start an online payment. Returns the provider checkout form to post the browser to; it never completes a payment itself. */
export const POST = route({ access: 'public', rateLimit: { name: 'public-invoice-pay', limit: 10, windowSec: 60, by: 'ip' } }, async ({ req, params, meta }) =>
  ok(await startOnlinePayment(params.token ?? '', await readBody(req), meta)),
);
