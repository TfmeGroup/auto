import { ok, route } from '@/server/http/route';
import { listAssignableRoles } from '@/server/memberships/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'employee.view' }, async ({ ctx }) => ok(await listAssignableRoles(ctx)));
