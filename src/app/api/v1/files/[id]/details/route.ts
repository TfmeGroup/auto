import { ok, route } from '@/server/http/route';
import { getFile } from '@/server/files/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'document.view' }, async ({ ctx, params }) => ok(await getFile(ctx, params.id ?? '')));
