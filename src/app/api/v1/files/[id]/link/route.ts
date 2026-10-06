import { ok, readBody, route } from '@/server/http/route';
import { createDownloadLink } from '@/server/files/service';

export const dynamic = 'force-dynamic';

/** A short-lived signed link to one file (5 minutes by default, 15 at most). */
export const POST = route({ access: 'business', permission: 'document.download', rateLimit: { name: 'file-link', limit: 120, windowSec: 60 } }, async ({ req, ctx, params }) => {
  const body = (await readBody(req)) as { ttlSeconds?: unknown };
  const ttl = typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined;
  return ok(await createDownloadLink(ctx, params.id ?? '', ttl));
});
