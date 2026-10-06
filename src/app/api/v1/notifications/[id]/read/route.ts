import { ok, route } from '@/server/http/route';
import { setRead } from '@/server/notifications/inapp';

export const dynamic = 'force-dynamic';

/** POST marks it read; DELETE marks it unread again. */
export const POST = route({ access: 'business', permission: null }, async ({ ctx, params }) => ok(await setRead(ctx, params.id ?? '', true)));
export const DELETE = route({ access: 'business', permission: null }, async ({ ctx, params }) => ok(await setRead(ctx, params.id ?? '', false)));
