import { ok, readBody, route } from '@/server/http/route';
import { saveJobTemplate } from '@/server/settings/catalogue';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'settings.manage_workshop', write: true, feature: 'advanced_settings' }, async ({ req, ctx, params }) => ok(await saveJobTemplate(ctx, params.id ?? '', await readBody(req))));
