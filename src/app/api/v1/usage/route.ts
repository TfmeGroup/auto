import { ok, route } from '@/server/http/route';
import { getUsage } from '@/server/usage/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['settings.view', 'settings.manage_billing'] }, async ({ ctx }) => ok(await getUsage(ctx)));
