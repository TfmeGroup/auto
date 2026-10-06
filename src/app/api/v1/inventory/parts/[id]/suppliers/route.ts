import { ok, readBody, route } from '@/server/http/route';
import { linkSupplier } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx, params }) => {
  return ok(await linkSupplier(ctx, params.id ?? '', await readBody(req)));
});
