import { ok, route } from '@/server/http/route';
import { getPartStock } from '@/server/inventory/stock';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ ctx, params }) => {
  return ok(await getPartStock(ctx, params.id ?? ''));
});
