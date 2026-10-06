import { route } from '@/server/http/route';
import { openPublicJobFile } from '@/server/documents/customer';
import { fileResponse } from '@/server/files/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'public', rateLimit: { name: 'public-job-file', limit: 120, windowSec: 60, by: 'ip' } }, async ({ req, params, meta }) => {
  const q = new URL(req.url).searchParams;
  const r = await openPublicJobFile(params.token ?? '', params.fileId ?? '', meta, { thumbnail: q.get('thumb') === '1' });
  return fileResponse(r, { download: q.get('download') === '1' });
});
