import { ok, readBody, route } from '@/server/http/route';
import { getJobCard, updateJob } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ ctx, params }) =>
  ok(await getJobCard(ctx, params.id ?? '')),
);

export const PATCH = route({ access: 'business', permission: 'job.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await updateJob(ctx, params.id ?? '', await readBody(req))),
);
