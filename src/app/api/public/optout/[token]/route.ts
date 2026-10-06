import { ok, route } from '@/server/http/route';
import { applyOptOut } from '@/server/notifications/preferences';

export const dynamic = 'force-dynamic';

/** A customer turns off one kind of optional message. POST (not GET), so a link scanner or prefetch cannot trigger it. */
export const POST = route({ access: 'public', rateLimit: { name: 'public-optout', limit: 20, windowSec: 60, by: 'ip' } }, async ({ params }) => ok(await applyOptOut(params.token ?? '')));
