import { route } from '@/server/http/route';
import { openSignedFile } from '@/server/files/service';
import { fileResponse } from '@/server/files/http';

export const dynamic = 'force-dynamic';

/** A short-lived signed link. The signature, the expiry, the file's availability and the person's access are all checked again here. */
export const GET = route({ access: 'public', rateLimit: { name: 'public-file', limit: 60, windowSec: 60, by: 'ip' } }, async ({ req, params }) => {
  const r = await openSignedFile(params.token ?? '');
  return fileResponse(r, { download: new URL(req.url).searchParams.get('download') === '1' });
});
