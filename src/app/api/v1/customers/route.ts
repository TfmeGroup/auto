import { created, ok, readBody, readQuery, route } from '@/server/http/route';
import { createCustomer, customerListSchema, listCustomers } from '@/server/customers/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'customer.view' }, async ({ req, ctx }) => {
  const r = await listCustomers(ctx, readQuery(req, customerListSchema));
  return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'customer.create', write: true }, async ({ req, ctx }) =>
  created(await createCustomer(ctx, await readBody(req))),
);
