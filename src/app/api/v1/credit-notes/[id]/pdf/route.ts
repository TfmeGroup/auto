import { rawQuery, route } from '@/server/http/route';
import { getCreditNotePdf } from '@/server/finance/pdfs';
import { pdfResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "credit_note.view" }, async ({ req, ctx, params }) => {
  const r = await getCreditNotePdf(ctx, params.id ?? ''); return pdfResponse(r.pdf, r.filename, { download: rawQuery(req).download === '1' });
});
