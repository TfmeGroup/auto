import { route } from '@/server/http/route';
import { getPublicLogo } from '@/server/finance/pdfs';
import { streamResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'public', rateLimit: { name: 'public-quote-logo', limit: 60, windowSec: 60, by: 'ip' } }, async ({ params }) => {
  const r = await getPublicLogo(params.token ?? '', 'QUOTE');
  return streamResponse(r.stream, r.size, r.mime);
});
