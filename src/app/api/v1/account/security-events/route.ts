import { ok, readQuery, route } from '@/server/http/route';
import { listMySecurityEvents, securityEventsSchema } from '@/server/account/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'user' }, async ({ req, ctx }) => {
  const r = await listMySecurityEvents(ctx, readQuery(req, securityEventsSchema));
  return ok(r.items, r.meta);
});
