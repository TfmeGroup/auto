import { ok, rawQuery, route } from '@/server/http/route';
import { listPartPrices } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view_costs' }, async ({ req, ctx, params }) => {
  const r = await listPartPrices(ctx, params.id ?? '', rawQuery(req)); return ok(r.items, r.meta);
});
