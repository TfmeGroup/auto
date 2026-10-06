import { rawQuery, route } from '@/server/http/route';
import { fileResponse } from '@/server/finance/http';
import { exportAuditLog } from '@/server/admin/audit';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'audit.view' }, async ({ req, ctx }) => {
  const r = await exportAuditLog(ctx, rawQuery(req));
  return fileResponse(r.data, 'text/csv; charset=utf-8', r.filename);
});
