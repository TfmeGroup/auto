import { created, readBody, route } from '@/server/http/route';
import { receiveGoods } from '@/server/inventory/receiving';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.receive', write: true, feature: 'purchase_orders' }, async ({ req, ctx, params }) => {
  return created(await receiveGoods(ctx, params.id ?? '', await readBody(req)));
});
