import { ok, route } from '@/server/http/route';
import { getCommunication } from '@/server/notifications/history';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'notification.view_history', feature: 'communication_history' }, async ({ ctx, params }) => ok(await getCommunication(ctx, params.id ?? '')));
