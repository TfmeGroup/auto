import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listJobTemplates, saveJobTemplate } from '@/server/settings/catalogue';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ req, ctx }) => ok(await listJobTemplates(ctx, { includeArchived: rawQuery(req).archived === 'true' })));
export const POST = route({ access: 'business', permission: 'settings.manage_workshop', write: true, feature: 'advanced_settings' }, async ({ req, ctx }) => created(await saveJobTemplate(ctx, null, await readBody(req))));
