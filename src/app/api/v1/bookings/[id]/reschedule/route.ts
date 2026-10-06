import { ok, readBody, route } from '@/server/http/route';
import { rescheduleBooking } from '@/server/bookings/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'booking.reschedule', write: true }, async ({ req, ctx, params }) =>
  ok(await rescheduleBooking(ctx, params.id ?? '', await readBody(req))),
);
