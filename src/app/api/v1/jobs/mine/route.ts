import { ok, route } from '@/server/http/route';
import { listMyJobs } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ ctx }) =>
  ok(await listMyJobs(ctx)),
);
