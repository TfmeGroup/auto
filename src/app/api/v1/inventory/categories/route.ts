import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listCategories, createCategory } from '@/server/inventory/categories';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  return ok(await listCategories(ctx, { includeArchived: rawQuery(req).archived === '1' }));
});

export const POST = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx }) => {
  return created(await createCategory(ctx, await readBody(req)));
});
