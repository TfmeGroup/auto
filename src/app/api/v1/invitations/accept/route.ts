import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { acceptInvitation } from '@/server/memberships/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user', rateLimit: { name: 'invite-accept', limit: 20, windowSec: 3600 } }, async ({ req, ctx }) => {
  const { token } = await readJson(req, z.object({ token: z.string().min(20).max(200) }));
  return ok(await acceptInvitation(ctx, token));
});
