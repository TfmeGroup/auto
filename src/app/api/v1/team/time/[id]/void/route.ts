import { ok, readBody, route } from '@/server/http/route';
import { voidTimeEntry } from '@/server/team/time';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'time.edit', write: true, feature: 'technician_management' }, async ({ req, ctx, params }) => {
  return ok(await voidTimeEntry(ctx, params.id ?? '', await readBody(req)));
});
