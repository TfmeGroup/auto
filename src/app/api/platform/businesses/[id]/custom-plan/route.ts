import { ok, readBody, route } from '@/server/http/route';
import { assignCustomPlan } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'platform' }, async ({ req, ctx, params }) =>
  ok(await assignCustomPlan(ctx, params.id ?? '', await readBody(req))),
);
