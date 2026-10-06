import { ok, rawQuery, route } from '@/server/http/route';
import { runSavedReport } from '@/server/reports/saved';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.view' }, async ({ req, ctx, params }) => {
  const q = rawQuery(req) as Record<string, string>;
  return ok(await runSavedReport(ctx, params.id ?? '', { page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50 }));
});
