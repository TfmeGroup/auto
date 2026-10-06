import { ok, rawQuery, route } from '@/server/http/route';
import { cancelImport, getImport } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'data.import' }, async ({ req, ctx, params }) => {
  const q = rawQuery(req);
  return ok(await getImport(ctx, params.id ?? '', { status: q.status || undefined, page: Number(q.page) || 1 }));
});
export const DELETE = route({ access: 'business', permission: 'data.import', write: true }, async ({ ctx, params }) => ok(await cancelImport(ctx, params.id ?? '')));
