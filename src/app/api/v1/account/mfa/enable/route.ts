import { ok, readBody, route } from '@/server/http/route';
import { enableMfa } from '@/server/auth/mfa';

export const dynamic = 'force-dynamic';

/** Verify the first code, turn MFA on, and return the one-time recovery codes. */
export const POST = route({ access: 'user' }, async ({ req, ctx }) => ok(await enableMfa(ctx, await readBody(req))));
