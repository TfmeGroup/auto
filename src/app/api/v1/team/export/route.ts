import { rawQuery, route } from '@/server/http/route';
import { exportTeam } from '@/server/team/exports';
import { fileResponse } from '@/server/finance/http';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.export' }, async ({ req, ctx }) => {
  const r = await exportTeam(ctx, rawQuery(req)); return fileResponse(r.data, r.mime, r.filename);
});
