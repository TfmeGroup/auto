import { rawQuery, route } from '@/server/http/route';
import { fileResponse } from '@/server/finance/http';
import { exportReport } from '@/server/reports/export';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.export' }, async ({ req, ctx, params }) => {
  const r = await exportReport(ctx, params.key ?? '', rawQuery(req) as Record<string, unknown>);
  return fileResponse(r.data, r.mime, r.filename);
});
