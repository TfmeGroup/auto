import { ok, readCookie, route } from '@/server/http/route';
import { authenticate, resolveBusinessContext } from '@/server/tenancy/context';
import { listMyBusinesses } from '@/server/businesses/service';
import { SESSION_COOKIE } from '@/server/auth/session';
import { AppError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** Who am I, which businesses can I act in, and what may I do in the current one. */
export const GET = route({ access: 'user' }, async ({ req, ctx, meta }) => {
  const businesses = await listMyBusinesses(ctx.user.id);
  let current = null;
  const auth = await authenticate(readCookie(req, SESSION_COOKIE), meta);
  if (auth) {
    try {
      const b = await resolveBusinessContext(auth);
      current = {
        id: b.business.id,
        name: b.business.name,
        role: b.membership.roleName,
        permissions: [...b.permissions].sort(),
        subscription: {
          status: b.subscription.status,
          planName: b.subscription.planName,
          trialEndsAt: b.subscription.trialEndsAt,
          currentPeriodEnd: b.subscription.currentPeriodEnd,
          canWrite: b.subscription.canWrite,
        },
      };
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'NO_BUSINESS')) throw e;
    }
  }
  return ok({ user: ctx.user, businesses, business: current });
});
