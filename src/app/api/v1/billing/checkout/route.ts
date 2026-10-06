import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { startCheckout } from '@/server/billing/plan-change';

export const dynamic = 'force-dynamic';

// Billing stays usable while the business is read-only, so an expired business can always pay to reactivate.
export const POST = route(
  { access: 'business', permission: 'settings.manage_billing', rateLimit: { name: 'checkout', limit: 10, windowSec: 3600 } },
  async ({ req, ctx }) => {
    const { planKey } = await readJson(req, z.object({ planKey: z.string().min(1).max(40) }));
    return ok(await startCheckout(ctx, planKey));
  },
);
