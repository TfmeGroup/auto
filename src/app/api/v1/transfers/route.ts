import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listTransfers, createTransfer } from '@/server/inventory/transfers';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  const r = await listTransfers(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'inventory.transfer', write: true, feature: 'multi_location' }, async ({ req, ctx }) => {
  return created(await createTransfer(ctx, await readBody(req)));
});
