import { ok, route } from '@/server/http/route';
import { getEntitlements } from '@/server/billing/entitlements';

export const dynamic = 'force-dynamic';

// What this business's plan allows and how much of it is used. Any member may read it (it is what decides which screens they see);
// it holds no billing or payment detail. The services still enforce every limit and feature themselves.
export const GET = route({ access: 'business', permission: null }, async ({ ctx }) => ok(await getEntitlements(ctx)));
