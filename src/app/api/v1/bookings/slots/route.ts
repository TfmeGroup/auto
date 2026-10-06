import { ok, rawQuery, route } from '@/server/http/route';
import { findFreeSlots } from '@/server/bookings/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'booking.view' }, async ({ req, ctx }) =>
  ok(await findFreeSlots(ctx, rawQuery(req))),
);
