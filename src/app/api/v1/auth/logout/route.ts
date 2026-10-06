import { ok, route } from '@/server/http/route';
import { logout } from '@/server/auth/service';
import { clearSessionCookie } from '@/server/http/cookies';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ ctx }) => {
  await logout(ctx);
  return ok(null, undefined, { cookies: [clearSessionCookie()] });
});
