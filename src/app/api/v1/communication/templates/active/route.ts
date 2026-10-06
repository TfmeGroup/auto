import { ok, readBody, route } from '@/server/http/route';
import { setTemplateActive } from '@/server/notifications/templates-admin';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'notification.manage_templates', write: true }, async ({ req, ctx }) => {
  const b = (await readBody(req)) as { event?: string; channel?: string; active?: boolean };
  return ok(await setTemplateActive(ctx, b.event ?? '', b.channel ?? '', b.active !== false));
});
