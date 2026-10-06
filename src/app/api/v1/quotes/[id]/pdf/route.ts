import { rawQuery, route } from '@/server/http/route';
import { getQuotePdf } from '@/server/finance/pdfs';
import { pdfResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "quote.view" }, async ({ req, ctx, params }) => {
  const r = await getQuotePdf(ctx, params.id ?? '', rawQuery(req).version); return pdfResponse(r.pdf, r.filename, { download: rawQuery(req).download === '1' });
});
