import { ok, route } from '@/server/http/route';
import { getSeatUsage } from '@/server/team/directory';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'employee.view' }, async ({ ctx }) => {
  return ok(await getSeatUsage(ctx));
});
