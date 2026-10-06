import { ok, readBody, route } from '@/server/http/route';
import { updateRecommendedWork, removeRecommendedWork } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ req, ctx, params }) =>
  ok(await updateRecommendedWork(ctx, params.id ?? '', params.workId ?? '', await readBody(req))),
);

export const DELETE = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ ctx, params }) =>
  ok(await removeRecommendedWork(ctx, params.id ?? '', params.workId ?? '').then(() => null)),
);
