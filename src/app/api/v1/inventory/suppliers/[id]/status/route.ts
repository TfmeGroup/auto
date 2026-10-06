import { ok, readBody, route } from '@/server/http/route';
import { setSupplierStatus } from '@/server/inventory/suppliers';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.manage_suppliers', write: true }, async ({ req, ctx, params }) => {
  const b = (await readBody(req)) as { status?: string }; return ok(await setSupplierStatus(ctx, params.id ?? '', b.status as 'ACTIVE'));
});
