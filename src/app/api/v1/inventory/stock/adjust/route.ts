import { ok, readBody, route } from '@/server/http/route';
import { adjustStock } from '@/server/inventory/stock';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.adjust', write: true }, async ({ req, ctx }) => {
  return ok(await adjustStock(ctx, await readBody(req)));
});
