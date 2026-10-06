import { ok, readBody, route } from '@/server/http/route';
import { openFile, updateFile } from '@/server/files/service';
import { fileResponse } from '@/server/files/http';

export const dynamic = 'force-dynamic';

/** Authenticated, permission-checked file bytes. ?thumb=1 gives the thumbnail, ?download=1 forces a download. Objects are never publicly addressable. */
export const GET = route({ access: 'business', permission: 'document.download', rateLimit: { name: 'file-download', limit: 600, windowSec: 60 } }, async ({ req, ctx, params }) => {
  const q = new URL(req.url).searchParams;
  const purpose = q.get('thumb') === '1' ? 'thumbnail' : q.get('download') === '1' ? 'download' : 'preview';
  const r = await openFile(ctx, params.id ?? '', purpose);
  return fileResponse(r, { download: q.get('download') === '1' });
});

export const PATCH = route({ access: 'business', permission: 'document.edit', write: true }, async ({ req, ctx, params }) => ok(await updateFile(ctx, params.id ?? '', await readBody(req))));
