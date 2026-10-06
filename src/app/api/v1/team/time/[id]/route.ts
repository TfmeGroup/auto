import { ok, readBody, route } from '@/server/http/route';
import { editTimeEntry } from '@/server/team/time';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'time.edit', write: true, feature: 'technician_management' }, async ({ req, ctx, params }) => {
  return ok(await editTimeEntry(ctx, params.id ?? '', await readBody(req)));
});
