import { ok, readBody, route } from '@/server/http/route';
import { cancelPurchaseOrder } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.purchase', write: true, feature: 'purchase_orders' }, async ({ req, ctx, params }) => {
  return ok(await cancelPurchaseOrder(ctx, params.id ?? '', await readBody(req)));
});
