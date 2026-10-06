import { ok, readBody, route } from '@/server/http/route';
import { updateDiagnosis } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ req, ctx, params }) =>
  ok(await updateDiagnosis(ctx, params.id ?? '', params.diagnosisId ?? '', await readBody(req))),
);
