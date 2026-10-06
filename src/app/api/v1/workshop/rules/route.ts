import { ok, readBody, route } from '@/server/http/route';
import { getRules, updateRules } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['booking.view', 'job.view', 'booking.manage'] }, async ({ ctx }) =>
  ok(await getRules(ctx)),
);

export const PATCH = route({ access: 'business', permission: 'booking.manage', write: true }, async ({ req, ctx }) =>
  ok(await updateRules(ctx, await readBody(req))),
);
