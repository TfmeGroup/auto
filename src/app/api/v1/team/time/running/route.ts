import { ok, route } from '@/server/http/route';
import { getRunningTimer } from '@/server/team/time';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'time.record', feature: 'technician_management' }, async ({ ctx }) => {
  return ok(await getRunningTimer(ctx));
});
