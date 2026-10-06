import { ok, route } from '@/server/http/route';
import { archiveFile } from '@/server/files/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'document.delete', write: true }, async ({ ctx, params }) => {
  await archiveFile(ctx, params.id ?? '');
  return ok(null);
});
