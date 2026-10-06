import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { cancelScheduledDowngrade, scheduleDowngrade } from '@/server/billing/plan-change';

export const dynamic = 'force-dynamic';

/** Schedule a downgrade for the end of the paid period. Refused while usage exceeds the target plan. */
export const POST = route(
  { access: 'business', permission: 'settings.manage_billing', rateLimit: { name: 'downgrade', limit: 10, windowSec: 3600 } },
  async ({ req, ctx }) => {
    const { planKey } = await readJson(req, z.object({ planKey: z.string().min(1).max(40) }));
    return ok(await scheduleDowngrade(ctx, planKey));
  },
);

export const DELETE = route({ access: 'business', permission: 'settings.manage_billing' }, async ({ ctx }) => {
  await cancelScheduledDowngrade(ctx);
  return ok(null);
});
