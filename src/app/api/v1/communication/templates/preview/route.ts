import { ok, readBody, route } from '@/server/http/route';
import { previewTemplate } from '@/server/notifications/templates-admin';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'notification.manage_templates', rateLimit: { name: 'tpl-preview', limit: 120, windowSec: 60 } }, async ({ req, ctx }) => ok(await previewTemplate(ctx, await readBody(req))));
