import { ok, readBody, route } from '@/server/http/route';
import { disableMfa } from '@/server/auth/mfa';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ req, ctx }) => {
  await disableMfa(ctx, await readBody(req));
  return ok(null);
});
