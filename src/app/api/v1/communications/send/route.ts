import { created, readBody, route } from '@/server/http/route';
import { sendManualMessage } from '@/server/notifications/manual';

export const dynamic = 'force-dynamic';

/** One message to one customer about one record. There is no way to send to a list. */
export const POST = route({ access: 'business', permission: 'notification.send', write: true, rateLimit: { name: 'comm-send', limit: 30, windowSec: 3600 } }, async ({ req, ctx }) => created(await sendManualMessage(ctx, await readBody(req))));
