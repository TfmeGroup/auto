import { ok, route } from '@/server/http/route';
import { getBillingOverview } from '@/server/billing/overview';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.manage_billing' }, async ({ ctx }) => ok(await getBillingOverview(ctx)));
