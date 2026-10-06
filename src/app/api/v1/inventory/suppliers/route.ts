import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listSuppliers, createSupplier } from '@/server/inventory/suppliers';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  const r = await listSuppliers(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'inventory.manage_suppliers', write: true }, async ({ req, ctx }) => {
  return created(await createSupplier(ctx, await readBody(req)));
});
