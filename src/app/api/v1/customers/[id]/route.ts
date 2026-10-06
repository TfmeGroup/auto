import { ok, readBody, route } from '@/server/http/route';
import { getCustomer, updateCustomer } from '@/server/customers/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'customer.view' }, async ({ ctx, params }) =>
  ok(await getCustomer(ctx, params.id ?? '')),
);

export const PATCH = route({ access: 'business', permission: 'customer.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await updateCustomer(ctx, params.id ?? '', await readBody(req))),
);
