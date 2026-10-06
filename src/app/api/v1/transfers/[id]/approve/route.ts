import { ok, route } from '@/server/http/route';
import { approveTransfer } from '@/server/inventory/transfers';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.approve_purchase', write: true, feature: 'multi_location' }, async ({ ctx, params }) => {
  return ok(await approveTransfer(ctx, params.id ?? ''));
});
