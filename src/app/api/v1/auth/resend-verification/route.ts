import { ok, route } from '@/server/http/route';
import { resendVerification } from '@/server/auth/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ ctx }) => {
  await resendVerification(ctx);
  return ok(null);
});
