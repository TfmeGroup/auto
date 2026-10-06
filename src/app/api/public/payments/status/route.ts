import { ok, route } from '@/server/http/route';
import { getPublicPaymentStatus } from '@/server/finance/online';

export const dynamic = 'force-dynamic';

/** What the "back from the payment provider" page shows. Read-only: a browser returning from the provider never changes a payment. */
export const GET = route({ access: 'public', rateLimit: { name: 'public-payment-status', limit: 60, windowSec: 60, by: 'ip' } }, async ({ req }) => {
  const p = new URL(req.url).searchParams;
  return ok(await getPublicPaymentStatus(p.get('b') ?? '', p.get('ref') ?? ''));
});
