import { ok, readBody, route } from '@/server/http/route';
import { sendInvoice } from '@/server/finance/invoices';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "invoice.send", write: true }, async ({ req, ctx, params }) => {
  return ok(await sendInvoice(ctx, params.id ?? '', await readBody(req)));
});
