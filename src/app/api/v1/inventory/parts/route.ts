import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listParts, createPart } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'inventory.view' }, async ({ req, ctx }) => {
  const r = await listParts(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'inventory.create', write: true }, async ({ req, ctx }) => {
  return created(await createPart(ctx, await readBody(req)));
});
