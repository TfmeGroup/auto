import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listInvoices, createInvoice } from '@/server/finance/invoices';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "invoice.view" }, async ({ req, ctx }) => {
  const r = await listInvoices(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: "invoice.create", write: true }, async ({ req, ctx }) => {
  return created(await createInvoice(ctx, await readBody(req)));
});
