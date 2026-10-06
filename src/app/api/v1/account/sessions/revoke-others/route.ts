import { ok, route } from '@/server/http/route';
import { revokeOtherSessions } from '@/server/account/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ ctx }) => ok(await revokeOtherSessions(ctx)));
