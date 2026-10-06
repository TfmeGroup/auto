import { ok, readBody, route } from '@/server/http/route';
import { getPart, updatePart } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ ctx, params }) => {
  return ok(await getPart(ctx, params.id ?? ''));
});

export const PATCH = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx, params }) => {
  return ok(await updatePart(ctx, params.id ?? '', await readBody(req)));
});
