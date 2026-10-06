import { ok, rawQuery, route } from '@/server/http/route';
import { searchAuditLog } from '@/server/admin/audit';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'audit.view' }, async ({ req, ctx }) => {
  const r = await searchAuditLog(ctx, rawQuery(req));
  return ok(r.items, r.meta);
});
