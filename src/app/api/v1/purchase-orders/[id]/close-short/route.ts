import { ok, readBody, route } from '@/server/http/route';
import { closePurchaseOrderShort } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.receive', write: true, feature: 'purchase_orders' }, async ({ req, ctx, params }) => {
  return ok(await closePurchaseOrderShort(ctx, params.id ?? '', await readBody(req)));
});
