import { ok, route } from '@/server/http/route';
import { reconcileStorage } from '@/server/files/usage';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'document.manage', rateLimit: { name: 'file-reconcile', limit: 10, windowSec: 3600 } }, async ({ ctx }) => ok(await reconcileStorage(ctx)));
