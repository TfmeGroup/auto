import { ok, route } from '@/server/http/route';
import { getAlerts } from '@/server/admin/alerts';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: null }, async ({ ctx }) => ok(await getAlerts(ctx)));
