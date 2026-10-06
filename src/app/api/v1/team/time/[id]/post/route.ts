import { ok, route } from '@/server/http/route';
import { postTimeToLabour } from '@/server/team/time';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: ['time.edit', 'time.record'], write: true, feature: 'technician_management' }, async ({ ctx, params }) => {
  return ok(await postTimeToLabour(ctx, params.id ?? ''));
});
