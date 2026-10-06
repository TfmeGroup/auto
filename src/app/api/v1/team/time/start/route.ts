import { ok, readBody, route } from '@/server/http/route';
import { startTimer } from '@/server/team/time';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'time.record', write: true, feature: 'technician_management' }, async ({ req, ctx }) => {
  return ok(await startTimer(ctx, await readBody(req)));
});
