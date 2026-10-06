import { ok, readBody, route } from '@/server/http/route';
import { updateCheckIn } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'job.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await updateCheckIn(ctx, params.id ?? '', await readBody(req))),
);
