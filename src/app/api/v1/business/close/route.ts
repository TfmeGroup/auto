import { ok, readBody, route } from '@/server/http/route';
import { closeBusiness } from '@/server/businesses/service';

export const dynamic = 'force-dynamic';

// Closing is allowed even when read-only (an expired business must still be able to close).
export const POST = route(
  { access: 'business', permission: 'business.close', rateLimit: { name: 'close-business', limit: 5, windowSec: 3600 } },
  async ({ req, ctx }) => ok(await closeBusiness(ctx, await readBody(req))),
);
