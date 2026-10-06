import { ok, route } from '@/server/http/route';
import { memberSignInStatus } from '@/server/admin/audit';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'security.view_events', feature: 'advanced_admin' }, async ({ ctx }) => ok(await memberSignInStatus(ctx)));
