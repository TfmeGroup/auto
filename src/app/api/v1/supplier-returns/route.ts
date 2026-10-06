import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listSupplierReturns, createSupplierReturn } from '@/server/inventory/receiving';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  const r = await listSupplierReturns(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'inventory.return', write: true, feature: 'purchase_orders' }, async ({ req, ctx }) => {
  return created(await createSupplierReturn(ctx, await readBody(req)));
});
