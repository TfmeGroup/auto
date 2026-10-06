import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listWaitingEntries, addWaitingEntry } from '@/server/bookings/extras';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'booking.view' }, async ({ req, ctx }) => {
  const r = await listWaitingEntries(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'booking.create', write: true }, async ({ req, ctx }) =>
  created(await addWaitingEntry(ctx, await readBody(req))),
);
