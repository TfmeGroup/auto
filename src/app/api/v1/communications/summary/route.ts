import { ok, route } from '@/server/http/route';
import { communicationSummary } from '@/server/notifications/history';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'notification.view_history', feature: 'communication_history' }, async ({ ctx }) => ok(await communicationSummary(ctx)));
