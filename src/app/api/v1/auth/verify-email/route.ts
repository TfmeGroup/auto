import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { verifyEmail } from '@/server/auth/service';

export const dynamic = 'force-dynamic';

export const POST = route(
  { access: 'public', rateLimit: { name: 'verify-email', limit: 20, windowSec: 3600, by: 'ip' } },
  async ({ req, meta }) => {
    const { token } = await readJson(req, z.object({ token: z.string().min(20).max(200) }));
    await verifyEmail(token, meta);
    return ok(null);
  },
);
