import { ok, route } from '@/server/http/route';
import { markAllRead } from '@/server/notifications/inapp';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: null }, async ({ ctx }) => ok(await markAllRead(ctx)));
