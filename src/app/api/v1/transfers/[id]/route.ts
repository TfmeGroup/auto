import { ok, route } from '@/server/http/route';
import { getTransfer } from '@/server/inventory/transfers';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ ctx, params }) => {
  return ok(await getTransfer(ctx, params.id ?? ''));
});
