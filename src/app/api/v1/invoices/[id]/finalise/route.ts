import { ok, route } from '@/server/http/route';
import { finaliseInvoice } from '@/server/finance/invoices';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "invoice.finalise", write: true }, async ({ ctx, params }) => {
  return ok(await finaliseInvoice(ctx, params.id ?? ''));
});
