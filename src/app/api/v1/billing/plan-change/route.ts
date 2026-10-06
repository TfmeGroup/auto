import { z } from 'zod';
import { ok, readQuery, route } from '@/server/http/route';
import { evaluatePlanChange } from '@/server/billing/plan-change';

export const dynamic = 'force-dynamic';

/** Preview a plan change: prices, limit and feature differences, and anything blocking it. Changes nothing. */
export const GET = route({ access: 'business', permission: 'settings.manage_billing' }, async ({ req, ctx }) => {
  const { plan } = readQuery(req, z.object({ plan: z.string().min(1).max(40) }));
  return ok(await evaluatePlanChange(ctx, plan));
});
