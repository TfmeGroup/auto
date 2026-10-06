import { ok, readBody, route } from '@/server/http/route';
import { updateJobPart, removeJobPart } from '@/server/jobcards/items';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'job.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await updateJobPart(ctx, params.id ?? '', params.partId ?? '', await readBody(req))),
);

export const DELETE = route({ access: 'business', permission: 'job.edit', write: true }, async ({ ctx, params }) =>
  ok(await removeJobPart(ctx, params.id ?? '', params.partId ?? '').then(() => null)),
);
