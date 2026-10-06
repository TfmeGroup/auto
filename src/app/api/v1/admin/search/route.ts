import { ok, rawQuery, route } from '@/server/http/route';
import { adminSearch } from '@/server/admin/search';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'admin.view', feature: 'advanced_admin' }, async ({ req, ctx }) => ok(await adminSearch(ctx, rawQuery(req))));
