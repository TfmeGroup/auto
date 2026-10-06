import { rawQuery, route } from '@/server/http/route';
import { getReceiptPdf } from '@/server/finance/pdfs';
import { pdfResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "payment.view" }, async ({ req, ctx, params }) => {
  const r = await getReceiptPdf(ctx, params.id ?? ''); return pdfResponse(r.pdf, r.filename, { download: rawQuery(req).download === '1' });
});
