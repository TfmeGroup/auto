import { ok, readBody, route } from '@/server/http/route';
import { setStockBin } from '@/server/inventory/stock';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx, params }) => {
  return ok(await setStockBin(ctx, params.id ?? '', await readBody(req)));
});
