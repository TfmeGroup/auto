import { rawQuery, route } from '@/server/http/route';
import { getInvoicePdf } from '@/server/finance/pdfs';
import { pdfResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "invoice.view" }, async ({ req, ctx, params }) => {
  const r = await getInvoicePdf(ctx, params.id ?? ''); return pdfResponse(r.pdf, r.filename, { download: rawQuery(req).download === '1' });
});
