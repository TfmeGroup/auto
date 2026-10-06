import { ok, readBody, route } from '@/server/http/route';
import { recordQualityCheck } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.quality_check', write: true }, async ({ req, ctx, params }) =>
  ok(await recordQualityCheck(ctx, params.id ?? '', await readBody(req))),
);
