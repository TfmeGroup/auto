import { ok, route } from '@/server/http/route';
import { purgeFile } from '@/server/files/lifecycle';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'document.purge', write: true }, async ({ ctx, params }) => {
  await purgeFile(ctx, params.id ?? '');
  return ok({ id: params.id, status: 'DELETED' });
});
