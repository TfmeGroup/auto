import { rawQuery, route } from '@/server/http/route';
import { fileResponse } from '@/server/finance/http';
import { exportSavedReport } from '@/server/reports/saved';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.export' }, async ({ req, ctx, params }) => {
  const r = await exportSavedReport(ctx, params.id ?? '', rawQuery(req) as { format?: string; columns?: string });
  return fileResponse(r.data, r.mime, r.filename);
});
