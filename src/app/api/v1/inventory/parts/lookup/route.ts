import { ok, rawQuery, route } from '@/server/http/route';
import { findPartByCode } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view', feature: 'barcode_workflows' }, async ({ req, ctx }) => {
  return ok(await findPartByCode(ctx, rawQuery(req).code ?? ''));
});
