import { ok, route } from '@/server/http/route';
import { trashFile } from '@/server/files/lifecycle';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'document.delete', write: true }, async ({ ctx, params }) => {
  const r = await trashFile(ctx, params.id ?? '');
  return ok(r ? { id: params.id, status: (r as { status?: string }).status } : null);
});
