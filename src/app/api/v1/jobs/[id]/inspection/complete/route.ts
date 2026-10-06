import { ok, route } from '@/server/http/route';
import { completeInspection } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ ctx, params }) =>
  ok(await completeInspection(ctx, params.id ?? '')),
);
