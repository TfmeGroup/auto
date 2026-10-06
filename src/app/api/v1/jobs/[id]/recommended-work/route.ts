import { created, ok, readBody, route } from '@/server/http/route';
import { listRecommendedWork, createRecommendedWork } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ ctx, params }) =>
  ok(await listRecommendedWork(ctx, params.id ?? '')),
);

export const POST = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ req, ctx, params }) =>
  created(await createRecommendedWork(ctx, params.id ?? '', await readBody(req))),
);
