import { ok, route } from '@/server/http/route';
import { getEmployee } from '@/server/team/directory';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'employee.view' }, async ({ ctx, params }) => {
  return ok(await getEmployee(ctx, params.id ?? ''));
});
