import { rawQuery, route } from '@/server/http/route';
import { purchaseOrderPdf } from '@/server/inventory/po-pdf';
import { pdfResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view_costs', feature: 'purchase_orders' }, async ({ req, ctx, params }) => {
  const r = await purchaseOrderPdf(ctx, params.id ?? ''); return pdfResponse(r.pdf, r.filename, { download: rawQuery(req).download === '1' });
});
