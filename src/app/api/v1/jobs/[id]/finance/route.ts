import { ok, route } from '@/server/http/route';
import { listJobInvoices } from '@/server/finance/invoices';
import { listJobQuotes } from '@/server/finance/quotes';
import { can } from '@/server/permissions/authorize';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "job.view" }, async ({ ctx, params }) => {
  const id = params.id ?? ''; return ok({ quotes: can(ctx, 'quote.view') ? await listJobQuotes(ctx, id) : [], invoices: can(ctx, 'invoice.view') ? await listJobInvoices(ctx, id) : [] });
});
