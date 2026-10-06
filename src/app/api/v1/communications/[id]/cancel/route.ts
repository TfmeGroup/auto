import { ok, route } from '@/server/http/route';
import { cancelCommunication } from '@/server/notifications/manual';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'notification.send', write: true }, async ({ ctx, params }) => ok(await cancelCommunication(ctx, params.id ?? '')));
