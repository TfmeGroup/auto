import { created, readBody, route } from '@/server/http/route';
import { addInspectionItem } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ req, ctx, params }) =>
  created(await addInspectionItem(ctx, params.id ?? '', await readBody(req))),
);
