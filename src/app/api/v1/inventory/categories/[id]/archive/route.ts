import { ok, readBody, route } from '@/server/http/route';
import { setCategoryArchived } from '@/server/inventory/categories';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx, params }) => {
  const b = (await readBody(req)) as { archived?: boolean }; return ok(await setCategoryArchived(ctx, params.id ?? '', b.archived !== false));
});
