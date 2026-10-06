import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listPurchaseOrders, createPurchaseOrder } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  const r = await listPurchaseOrders(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'inventory.purchase', write: true, feature: 'purchase_orders' }, async ({ req, ctx }) => {
  return created(await createPurchaseOrder(ctx, await readBody(req)));
});
