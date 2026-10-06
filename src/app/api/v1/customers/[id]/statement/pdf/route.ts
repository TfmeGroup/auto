import { rawQuery, route } from '@/server/http/route';
import { getStatementPdf } from '@/server/finance/statements';
import { pdfResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "invoice.view" }, async ({ req, ctx, params }) => {
  const r = await getStatementPdf(ctx, params.id ?? '', rawQuery(req)); return pdfResponse(r.pdf, r.filename, { download: rawQuery(req).download === '1' });
});
