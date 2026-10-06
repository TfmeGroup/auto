import { ok, readBody, route } from '@/server/http/route';
import { setBookingStatus } from '@/server/bookings/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'booking.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await setBookingStatus(ctx, params.id ?? '', await readBody(req))),
);
