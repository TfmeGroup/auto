import { ok, rawQuery, route } from '@/server/http/route';
import { listGenerations } from '@/server/documents/generator';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'document.manage' }, async ({ req, ctx }) => {
  const s = rawQuery(req).status;
  return ok(await listGenerations(ctx, { status: s === 'QUEUED' || s === 'DONE' || s === 'FAILED' ? s : undefined }));
});
