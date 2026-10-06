import { ok, route } from '@/server/http/route';
import { removeCompatibility } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const DELETE = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ ctx, params }) => {
  await removeCompatibility(ctx, params.id ?? '', params.ruleId ?? ''); return ok({ removed: true });
});
