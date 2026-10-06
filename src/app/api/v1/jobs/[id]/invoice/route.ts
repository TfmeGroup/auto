import { created, route } from '@/server/http/route';
import { createInvoiceFromJob } from '@/server/finance/invoices';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "invoice.create", write: true }, async ({ ctx, params }) => {
  return created(await createInvoiceFromJob(ctx, params.id ?? ''));
});
