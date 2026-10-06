import { ok, readBody, route } from '@/server/http/route';
import { cancelSubscription } from '@/server/billing/plan-change';

export const dynamic = 'force-dynamic';

export const POST = route(
  { access: 'business', permission: 'settings.manage_billing', rateLimit: { name: 'cancel-subscription', limit: 5, windowSec: 3600 } },
  async ({ req, ctx }) => ok(await cancelSubscription(ctx, await readBody(req))),
);
