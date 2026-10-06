import { ok, readBody, route } from '@/server/http/route';
import { getNumbering, updateNumbering } from '@/server/settings/config-service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await getNumbering(ctx)));
export const PATCH = route({ access: 'business', permission: 'settings.view', write: true }, async ({ req, ctx }) => ok(await updateNumbering(ctx, await readBody(req))));
