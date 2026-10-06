import { ok, readBody, route } from '@/server/http/route';
import { completeMfaLogin } from '@/server/auth/service';
import { setSessionCookie } from '@/server/http/cookies';

export const dynamic = 'force-dynamic';

/** Second step of sign-in: exchange the challenge token + a code (or recovery code) for a session. */
export const POST = route({ access: 'public' }, async ({ req, meta }) => {
  const { session, userId } = await completeMfaLogin(await readBody(req), meta);
  return ok({ userId }, undefined, { cookies: [setSessionCookie(session.token, session.expiresAt)] });
});
