import { ok, route } from '@/server/http/route';
import { revokeOwnSession } from '@/server/account/service';

export const dynamic = 'force-dynamic';

/** Sign out one of YOUR sessions (another person's id behaves as "not found"). */
export const DELETE = route({ access: 'user' }, async ({ ctx, params }) => {
  await revokeOwnSession(ctx, params.id ?? '');
  return ok(null);
});
