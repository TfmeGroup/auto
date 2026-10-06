import { ok, readBody, route } from '@/server/http/route';
import { deactivateAccount } from '@/server/account/service';
import { clearSessionCookie } from '@/server/http/cookies';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ req, ctx }) => {
  await deactivateAccount(ctx, await readBody(req));
  return ok(null, undefined, { cookies: [clearSessionCookie()] });
});
