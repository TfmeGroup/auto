import { ok, readQuery, route } from '@/server/http/route';
import { auditListSchema, listAuditLog } from '@/server/audit/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'audit.view' }, async ({ req, ctx }) => {
  const r = await listAuditLog(ctx, readQuery(req, auditListSchema));
  return ok(r.items, r.meta);
});
