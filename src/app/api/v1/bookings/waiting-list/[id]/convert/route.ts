import { created, readBody, route } from '@/server/http/route';
import { convertWaitingEntry } from '@/server/bookings/extras';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'booking.create', write: true }, async ({ req, ctx, params }) =>
  created(await convertWaitingEntry(ctx, params.id ?? '', await readBody(req))),
);
