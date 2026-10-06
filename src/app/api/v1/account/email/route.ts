import { ok, readBody, route } from '@/server/http/route';
import { requestEmailChange } from '@/server/account/service';

export const dynamic = 'force-dynamic';

// Same response whether or not the new address is already registered (no enumeration).
export const POST = route({ access: 'user', verified: true }, async ({ req, ctx }) => {
  await requestEmailChange(ctx, await readBody(req));
  return ok({ message: 'If that address can be used, we sent it a confirmation link. Your current address stays in use until you confirm.' });
});
