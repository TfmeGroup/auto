import { ok, rawQuery, route } from '@/server/http/route';
import { supplierPurchaseHistory } from '@/server/inventory/suppliers';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx, params }) => {
  const r = await supplierPurchaseHistory(ctx, params.id ?? '', rawQuery(req)); return ok(r.items, r.meta);
});
