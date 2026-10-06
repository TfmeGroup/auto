import { ok, readBody, route } from '@/server/http/route';
import { getPurchaseOrder, updatePurchaseOrder } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ ctx, params }) => {
  return ok(await getPurchaseOrder(ctx, params.id ?? ''));
});

export const PATCH = route({ access: 'business', permission: 'inventory.purchase', write: true, feature: 'purchase_orders' }, async ({ req, ctx, params }) => {
  return ok(await updatePurchaseOrder(ctx, params.id ?? '', await readBody(req)));
});
