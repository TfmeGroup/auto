import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listServiceCatalogue, saveService } from '@/server/settings/catalogue';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ req, ctx }) => ok(await listServiceCatalogue(ctx, { includeArchived: rawQuery(req).archived === 'true' })));
export const POST = route({ access: 'business', permission: 'settings.manage_workshop', write: true, feature: 'advanced_settings' }, async ({ req, ctx }) => created(await saveService(ctx, null, await readBody(req))));
