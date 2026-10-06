import { ok, readBody, route } from '@/server/http/route';
import { getSupplier, updateSupplier } from '@/server/inventory/suppliers';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ ctx, params }) => {
  return ok(await getSupplier(ctx, params.id ?? ''));
});

export const PATCH = route({ access: 'business', permission: 'inventory.manage_suppliers', write: true }, async ({ req, ctx, params }) => {
  return ok(await updateSupplier(ctx, params.id ?? '', await readBody(req)));
});
