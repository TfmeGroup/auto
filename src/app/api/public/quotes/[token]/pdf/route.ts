import { route } from '@/server/http/route';
import { getPublicQuotePdf } from '@/server/finance/pdfs';
import { pdfResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'public', rateLimit: { name: 'public-quote-pdf', limit: 30, windowSec: 60, by: 'ip' } }, async ({ req, params }) => {
  const r = await getPublicQuotePdf(params.token ?? '');
  return pdfResponse(r.pdf, r.filename, { download: new URL(req.url).searchParams.get('download') === '1' });
});
