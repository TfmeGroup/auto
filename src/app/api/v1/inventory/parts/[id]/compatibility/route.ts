import { created, readBody, route } from '@/server/http/route';
import { addCompatibility } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx, params }) => {
  return created(await addCompatibility(ctx, params.id ?? '', await readBody(req)));
});
