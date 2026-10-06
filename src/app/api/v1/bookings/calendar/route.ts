import { ok, rawQuery, route } from '@/server/http/route';
import { getCalendar } from '@/server/bookings/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'booking.view' }, async ({ req, ctx }) =>
  ok(await getCalendar(ctx, rawQuery(req))),
);
