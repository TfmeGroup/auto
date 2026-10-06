import { ok, readBody, route } from '@/server/http/route';
import { cancelInvoice } from '@/server/finance/invoices';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "invoice.cancel", write: true }, async ({ req, ctx, params }) => {
  return ok(await cancelInvoice(ctx, params.id ?? '', await readBody(req)));
});
