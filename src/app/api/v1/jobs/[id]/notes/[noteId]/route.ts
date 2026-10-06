import { ok, readBody, route } from '@/server/http/route';
import { setJobNoteVisibility } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'job.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await setJobNoteVisibility(ctx, params.id ?? '', params.noteId ?? '', (await readBody(req) as { visibility?: unknown }).visibility)),
);
