import { ok, route } from '@/server/http/route';
import { getAdminOverview } from '@/server/admin/overview';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'admin.view' }, async ({ ctx }) => ok(await getAdminOverview(ctx)));
