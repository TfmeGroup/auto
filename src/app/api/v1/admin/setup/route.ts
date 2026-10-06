import { ok, route } from '@/server/http/route';
import { getSetupCheck } from '@/server/admin/setup';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await getSetupCheck(ctx)));
