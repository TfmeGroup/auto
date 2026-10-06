import { ok, readBody, route } from '@/server/http/route';
import { assignTechnicians } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.assign', write: true }, async ({ req, ctx, params }) =>
  ok(await assignTechnicians(ctx, params.id ?? '', await readBody(req))),
);
