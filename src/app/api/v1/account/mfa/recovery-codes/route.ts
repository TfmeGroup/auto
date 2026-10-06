import { ok, readBody, route } from '@/server/http/route';
import { regenerateRecoveryCodes } from '@/server/auth/mfa';

export const dynamic = 'force-dynamic';

/** Replace all recovery codes (needs password + a current code). The new codes are shown once. */
export const POST = route({ access: 'user' }, async ({ req, ctx }) => ok(await regenerateRecoveryCodes(ctx, await readBody(req))));
