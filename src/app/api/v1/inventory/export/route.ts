import { rawQuery, route } from '@/server/http/route';
import { exportInventory } from '@/server/inventory/exports';
import { fileResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.export' }, async ({ req, ctx }) => {
  const r = await exportInventory(ctx, rawQuery(req)); return fileResponse(r.data, r.mime, r.filename);
});
