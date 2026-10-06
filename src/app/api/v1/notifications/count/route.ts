import { ok, route } from '@/server/http/route';
import { getUnreadCount } from '@/server/notifications/inapp';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: null }, async ({ ctx }) => ok({ unread: await getUnreadCount(ctx) }));
