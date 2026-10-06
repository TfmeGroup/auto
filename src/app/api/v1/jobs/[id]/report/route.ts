import { ok, rawQuery, route } from '@/server/http/route';
import { getInspectionReport } from '@/server/jobcards/reports';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ req, ctx, params }) =>
  ok(await getInspectionReport(ctx, params.id ?? '', rawQuery(req))),
);
