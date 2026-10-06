import { ok, route } from '@/server/http/route';
import { retryCommunication } from '@/server/notifications/manual';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'notification.send', write: true, rateLimit: { name: 'comm-retry', limit: 30, windowSec: 3600 } }, async ({ ctx, params }) => ok(await retryCommunication(ctx, params.id ?? '')));
