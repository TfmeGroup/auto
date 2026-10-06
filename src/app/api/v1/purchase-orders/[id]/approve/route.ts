import { ok, route } from '@/server/http/route';
import { approvePurchaseOrder } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.approve_purchase', write: true, feature: 'purchase_orders' }, async ({ ctx, params }) => {
  return ok(await approvePurchaseOrder(ctx, params.id ?? ''));
});
