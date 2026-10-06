import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listJobs, createJob } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ req, ctx }) => {
  const r = await listJobs(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'job.create', write: true }, async ({ req, ctx }) => {
  const r = await createJob(ctx, await readBody(req)); return r.created ? created(r.job) : ok(r.job);
});
