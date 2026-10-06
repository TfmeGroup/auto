import { ok, readBody, route } from '@/server/http/route';
import { getAccount, updateProfile } from '@/server/account/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'user' }, async ({ ctx }) => ok(await getAccount(ctx.user.id)));

export const PATCH = route({ access: 'user' }, async ({ req, ctx }) => ok(await updateProfile(ctx, await readBody(req))));
