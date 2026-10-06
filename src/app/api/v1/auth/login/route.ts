import { ok, readBody, route } from '@/server/http/route';
import { login } from '@/server/auth/service';
import { setSessionCookie } from '@/server/http/cookies';

export const dynamic = 'force-dynamic';

/**
 * Password step. If the account uses two-factor authentication no session is created yet: the
 * response carries a short-lived single-use challenge token (in the body only) that the client
 * exchanges, with a code, at /auth/mfa/verify.
 */
export const POST = route({ access: 'public' }, async ({ req, meta }) => {
  const r = await login(await readBody(req), meta);
  if (r.kind === 'mfa') return ok({ mfaRequired: true, challengeToken: r.challengeToken });
  return ok({ mfaRequired: false, userId: r.userId }, undefined, { cookies: [setSessionCookie(r.session.token, r.session.expiresAt)] });
});
