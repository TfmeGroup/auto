import { route } from '@/server/http/route';
import { getPublicJobLogo } from '@/server/documents/customer';
import { streamResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'public', rateLimit: { name: 'public-job-logo', limit: 60, windowSec: 60, by: 'ip' } }, async ({ params }) => {
  const r = await getPublicJobLogo(params.token ?? '');
  return streamResponse(r.stream, r.size, r.mime);
});
