import { ok, readBody, route } from '@/server/http/route';
import { setMemberLocations } from '@/server/team/directory';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'employee.edit', write: true, feature: 'multi_location' }, async ({ req, ctx, params }) => {
  return ok(await setMemberLocations(ctx, params.id ?? '', await readBody(req)));
});
