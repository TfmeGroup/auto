import { ok, readBody, route } from '@/server/http/route';
import { getCustomerPreferences, setCustomerPreferences } from '@/server/notifications/preferences';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'customer.view' }, async ({ ctx, params }) => ok(await getCustomerPreferences(ctx, params.id ?? '')));
export const PUT = route({ access: 'business', permission: 'notification.manage_preferences', write: true }, async ({ req, ctx, params }) => ok(await setCustomerPreferences(ctx, params.id ?? '', await readBody(req))));
