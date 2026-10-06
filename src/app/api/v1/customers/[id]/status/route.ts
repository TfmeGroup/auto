import { ok, readBody, route } from '@/server/http/route';
import { setCustomerStatus } from '@/server/customers/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'customer.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await setCustomerStatus(ctx, params.id ?? '', (await readBody(req) as { status?: unknown }).status)),
);
