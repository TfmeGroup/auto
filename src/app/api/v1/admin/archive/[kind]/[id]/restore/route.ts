import { ok, route } from '@/server/http/route';
import { restoreArchived } from '@/server/admin/archive';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'admin.view', feature: 'advanced_admin', write: true }, async ({ ctx, params }) => ok(await restoreArchived(ctx, params.kind ?? '', params.id ?? '')));
