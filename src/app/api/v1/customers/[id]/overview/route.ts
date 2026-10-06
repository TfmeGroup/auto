import { ok, route } from '@/server/http/route';
import { getCustomerOverview } from '@/server/customers/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'customer.view' }, async ({ ctx, params }) =>
  ok(await getCustomerOverview(ctx, params.id ?? '')),
);
