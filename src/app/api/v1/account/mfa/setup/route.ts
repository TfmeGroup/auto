import { ok, route } from '@/server/http/route';
import { startMfaSetup } from '@/server/auth/mfa';

export const dynamic = 'force-dynamic';

/** Begin authenticator-app enrolment. Returns the secret + QR once; nothing is active until a code is verified. */
export const POST = route({ access: 'user' }, async ({ ctx }) => ok(await startMfaSetup(ctx)));
