import { ok, readBody, route } from '@/server/http/route';
import { changeJobStatus } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.view', write: true }, async ({ req, ctx, params }) =>
  ok(await changeJobStatus(ctx, params.id ?? '', await readBody(req))),
);
