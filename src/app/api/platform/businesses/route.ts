import { ok, readQuery, route } from '@/server/http/route';
import { listBusinessesForPlatform, platformBusinessListSchema } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

/** TFME platform administration (platform_admins only, MFA required). Not reachable through any business role. */
export const GET = route({ access: 'platform' }, async ({ req, ctx }) => {
  const r = await listBusinessesForPlatform(ctx, readQuery(req, platformBusinessListSchema));
  return ok(r.items, r.meta);
});
