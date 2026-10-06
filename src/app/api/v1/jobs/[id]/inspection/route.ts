import { created, ok, readBody, route } from '@/server/http/route';
import { startInspection, updateInspectionNotes } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ ctx, params }) =>
  created(await startInspection(ctx, params.id ?? '')),
);

export const PATCH = route({ access: 'business', permission: 'job.inspect', write: true }, async ({ req, ctx, params }) =>
  ok(await updateInspectionNotes(ctx, params.id ?? '', await readBody(req))),
);
