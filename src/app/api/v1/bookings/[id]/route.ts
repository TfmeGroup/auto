import { ok, readBody, route } from '@/server/http/route';
import { getBooking, updateBooking } from '@/server/bookings/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'booking.view' }, async ({ ctx, params }) =>
  ok(await getBooking(ctx, params.id ?? '')),
);

export const PATCH = route({ access: 'business', permission: 'booking.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await updateBooking(ctx, params.id ?? '', await readBody(req))),
);
