import { ok, readBody, route } from '@/server/http/route';
import { updateCategory } from '@/server/inventory/categories';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx, params }) => {
  return ok(await updateCategory(ctx, params.id ?? '', await readBody(req)));
});
