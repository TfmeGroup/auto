import { ok, readBody, route } from '@/server/http/route';
import { cancelTransfer } from '@/server/inventory/transfers';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.transfer', write: true, feature: 'multi_location' }, async ({ req, ctx, params }) => {
  return ok(await cancelTransfer(ctx, params.id ?? '', await readBody(req)));
});
