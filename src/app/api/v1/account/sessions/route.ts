import { ok, route } from '@/server/http/route';
import { listSessions } from '@/server/account/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'user' }, async ({ ctx }) => ok(await listSessions(ctx)));
