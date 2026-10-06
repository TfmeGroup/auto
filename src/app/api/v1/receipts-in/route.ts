import { ok, rawQuery, route } from '@/server/http/route';
import { listReceipts } from '@/server/inventory/receiving';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  const r = await listReceipts(ctx, rawQuery(req)); return ok(r.items, r.meta);
});
