import { ok, readBody, route } from '@/server/http/route';
import { resetPassword } from '@/server/auth/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'public' }, async ({ req, meta }) => {
  await resetPassword(await readBody(req), meta);
  return ok(null);
});
