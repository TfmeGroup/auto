import { ok, readBody, route } from '@/server/http/route';
import { cancelBooking } from '@/server/bookings/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'booking.cancel', write: true }, async ({ req, ctx, params }) =>
  ok(await cancelBooking(ctx, params.id ?? '', await readBody(req))),
);
