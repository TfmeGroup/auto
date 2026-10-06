import { ok, readBody, route } from '@/server/http/route';
import { getInvoice, updateInvoice } from '@/server/finance/invoices';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "invoice.view" }, async ({ ctx, params }) => {
  return ok(await getInvoice(ctx, params.id ?? ''));
});

export const PATCH = route({ access: 'business', permission: "invoice.edit", write: true }, async ({ req, ctx, params }) => {
  return ok(await updateInvoice(ctx, params.id ?? '', await readBody(req)));
});
