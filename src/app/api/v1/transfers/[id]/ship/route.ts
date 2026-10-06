import { ok, route } from '@/server/http/route';
import { shipTransfer } from '@/server/inventory/transfers';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.transfer', write: true, feature: 'multi_location' }, async ({ ctx, params }) => {
  return ok(await shipTransfer(ctx, params.id ?? ''));
});
