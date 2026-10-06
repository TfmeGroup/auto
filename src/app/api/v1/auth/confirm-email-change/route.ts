import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { confirmEmailChange } from '@/server/account/service';
import { clearSessionCookie } from '@/server/http/cookies';

export const dynamic = 'force-dynamic';

export const POST = route(
  { access: 'public', rateLimit: { name: 'confirm-email-change', limit: 20, windowSec: 3600, by: 'ip' } },
  async ({ req, meta }) => {
    const { token } = await readJson(req, z.object({ token: z.string().min(20).max(200) }));
    await confirmEmailChange(token, meta);
    // Every session was revoked by the change; drop the (now dead) cookie too.
    return ok(null, undefined, { cookies: [clearSessionCookie()] });
  },
);
