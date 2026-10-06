import { ok, readBody, route } from '@/server/http/route';
import { cancelRecurringSeries } from '@/server/bookings/extras';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'booking.cancel', write: true }, async ({ req, ctx, params }) =>
  ok(await cancelRecurringSeries(ctx, params.id ?? '', await readBody(req))),
);
