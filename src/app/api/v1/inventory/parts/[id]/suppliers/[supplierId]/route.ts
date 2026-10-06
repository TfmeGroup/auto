import { ok, route } from '@/server/http/route';
import { unlinkSupplier } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const DELETE = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ ctx, params }) => {
  await unlinkSupplier(ctx, params.id ?? '', params.supplierId ?? ''); return ok({ removed: true });
});
