import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { setCustomerArchived } from '@/server/customers/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'customer.archive', write: true }, async ({ req, ctx, params }) => {
  const { archived } = await readJson(req, z.object({ archived: z.boolean() }));
  return ok(await setCustomerArchived(ctx, params.id ?? '', archived));
});
