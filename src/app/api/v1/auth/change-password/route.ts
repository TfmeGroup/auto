import { ok, readBody, route } from '@/server/http/route';
import { changePassword } from '@/server/auth/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ req, ctx }) => {
  await changePassword(ctx, await readBody(req));
  return ok(null);
});
