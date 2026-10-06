import { ok, route } from '@/server/http/route';
import { placePurchaseOrder } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.purchase', write: true, feature: 'purchase_orders' }, async ({ ctx, params }) => {
  return ok(await placePurchaseOrder(ctx, params.id ?? ''));
});
