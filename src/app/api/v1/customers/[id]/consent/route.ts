import { created, readBody, route } from '@/server/http/route';
import { recordConsent } from '@/server/notifications/preferences';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'notification.manage_preferences', write: true }, async ({ req, ctx, params }) => created(await recordConsent(ctx, params.id ?? '', await readBody(req))));
