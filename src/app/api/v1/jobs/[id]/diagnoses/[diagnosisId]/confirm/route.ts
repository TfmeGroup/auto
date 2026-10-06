import { ok, route } from '@/server/http/route';
import { confirmDiagnosis } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ ctx, params }) =>
  ok(await confirmDiagnosis(ctx, params.id ?? '', params.diagnosisId ?? '')),
);
