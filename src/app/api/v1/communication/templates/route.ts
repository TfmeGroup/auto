import { ok, readBody, route } from '@/server/http/route';
import { listTemplates, saveTemplate } from '@/server/notifications/templates-admin';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'notification.manage_templates' }, async ({ ctx }) => ok(await listTemplates(ctx)));
export const PUT = route({ access: 'business', permission: 'notification.manage_templates', write: true, feature: 'custom_templates' }, async ({ req, ctx }) => ok(await saveTemplate(ctx, await readBody(req))));
