import { rawQuery, route } from '@/server/http/route';
import { exportFinanceData } from '@/server/finance/exports';
import { fileResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "finance.export" }, async ({ req, ctx }) => {
  const r = await exportFinanceData(ctx, rawQuery(req)); return fileResponse(r.data, r.mime, r.filename);
});
