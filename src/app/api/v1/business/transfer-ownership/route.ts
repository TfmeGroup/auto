import { ok, readBody, route } from '@/server/http/route';
import { transferOwnership } from '@/server/businesses/service';

export const dynamic = 'force-dynamic';

// Re-authentication (password + MFA code) and a typed confirmation are checked inside the service.
export const POST = route(
  { access: 'business', permission: 'business.transfer_ownership', write: true, rateLimit: { name: 'transfer-ownership', limit: 5, windowSec: 3600 } },
  async ({ req, ctx }) => ok(await transferOwnership(ctx, await readBody(req))),
);
