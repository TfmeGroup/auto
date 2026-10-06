import { ok, rawQuery, route } from '@/server/http/route';
import { listPartJobs } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx, params }) => {
  const r = await listPartJobs(ctx, params.id ?? '', rawQuery(req)); return ok(r.items, r.meta);
});
