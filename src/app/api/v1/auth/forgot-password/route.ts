import { ok, readBody, route } from '@/server/http/route';
import { requestPasswordReset } from '@/server/auth/service';

export const dynamic = 'force-dynamic';

// Always the same answer: never reveals whether the email has an account.
export const POST = route({ access: 'public' }, async ({ req, meta }) => {
  await requestPasswordReset(await readBody(req), meta);
  return ok({ message: 'If that email has an account, a reset link is on its way.' });
});
