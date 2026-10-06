import { ok, readQuery, route } from '@/server/http/route';
import { invoiceListSchema, listSubscriptionInvoices } from '@/server/billing/overview';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.manage_billing' }, async ({ req, ctx }) => {
  const r = await listSubscriptionInvoices(ctx, readQuery(req, invoiceListSchema));
  return ok(r.items, r.meta);
});
