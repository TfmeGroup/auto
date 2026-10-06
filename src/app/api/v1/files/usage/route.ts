import { ok, route } from '@/server/http/route';
import { getStorageReport } from '@/server/files/usage';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'document.view' }, async ({ ctx }) => ok(await getStorageReport(ctx)));
