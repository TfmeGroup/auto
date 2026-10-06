import { ok, route } from '@/server/http/route';
import { listAssignmentHistory } from '@/server/team/assignments';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ ctx, params }) => {
  return ok(await listAssignmentHistory(ctx, params.id ?? ''));
});
