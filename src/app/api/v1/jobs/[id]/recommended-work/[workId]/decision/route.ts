import { ok, readBody, route } from '@/server/http/route';
import { decideRecommendedWork } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.approve_work', write: true }, async ({ req, ctx, params }) =>
  ok(await decideRecommendedWork(ctx, params.id ?? '', params.workId ?? '', await readBody(req))),
);
