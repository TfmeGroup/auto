import { ok, route } from '@/server/http/route';
import { approveTimeEntry } from '@/server/team/time';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'time.approve', write: true, feature: 'technician_management' }, async ({ ctx, params }) => {
  return ok(await approveTimeEntry(ctx, params.id ?? ''));
});
