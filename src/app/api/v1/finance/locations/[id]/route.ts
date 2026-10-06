import { ok, readBody, route } from '@/server/http/route';
import { setLocationDocCode } from '@/server/finance/settings';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'finance.manage_settings', write: true }, async ({ req, ctx, params }) =>
  ok(await setLocationDocCode(ctx, params.id ?? '', await readBody(req))),
);
