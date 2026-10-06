import { ok, rawQuery, route } from '@/server/http/route';
import { listEmployees } from '@/server/team/directory';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'employee.view' }, async ({ req, ctx }) => {
  const r = await listEmployees(ctx, rawQuery(req)); return ok(r.items, r.meta);
});
