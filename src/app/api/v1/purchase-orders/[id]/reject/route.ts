import { ok, readBody, route } from '@/server/http/route';
import { rejectPurchaseOrder } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.approve_purchase', write: true, feature: 'purchase_orders' }, async ({ req, ctx, params }) => {
  return ok(await rejectPurchaseOrder(ctx, params.id ?? '', await readBody(req)));
});
