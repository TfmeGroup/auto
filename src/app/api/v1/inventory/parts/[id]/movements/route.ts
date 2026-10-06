import { ok, rawQuery, route } from '@/server/http/route';
import { listMovements } from '@/server/inventory/stock';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx, params }) => {
  const r = await listMovements(ctx, { ...rawQuery(req), partId: params.id ?? '' }); return ok(r.items, r.meta);
});
