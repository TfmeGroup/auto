import { ok, route } from '@/server/http/route';
import { getMfaStatus } from '@/server/auth/mfa';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'user' }, async ({ ctx }) => ok(await getMfaStatus(ctx.user.id)));
