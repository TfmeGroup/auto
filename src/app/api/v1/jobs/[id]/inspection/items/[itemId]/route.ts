import { ok, readBody, route } from '@/server/http/route';
import { updateInspectionItem } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ req, ctx, params }) =>
  ok(await updateInspectionItem(ctx, params.id ?? '', params.itemId ?? '', await readBody(req))),
);
