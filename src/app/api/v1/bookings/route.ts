import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listBookings, createBooking } from '@/server/bookings/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'booking.view' }, async ({ req, ctx }) => {
  const r = await listBookings(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'booking.create', write: true }, async ({ req, ctx }) =>
  created(await createBooking(ctx, await readBody(req))),
);
