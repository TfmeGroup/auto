import { ok, readBody, route } from '@/server/http/route';
import { archiveLocation, renameLocation } from '@/server/locations/service';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: ['settings.edit', 'location.manage'], write: true }, async ({ req, ctx, params }) =>
  ok(await renameLocation(ctx, params.id ?? '', await readBody(req))),
);

export const DELETE = route({ access: 'business', permission: ['settings.edit', 'location.manage'], write: true }, async ({ ctx, params }) => {
  await archiveLocation(ctx, params.id ?? '');
  return ok(null);
});
