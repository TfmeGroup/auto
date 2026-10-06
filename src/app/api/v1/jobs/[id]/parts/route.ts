import { created, readBody, route } from '@/server/http/route';
import { addJobPart } from '@/server/jobcards/items';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.edit', write: true }, async ({ req, ctx, params }) =>
  created(await addJobPart(ctx, params.id ?? '', await readBody(req))),
);
