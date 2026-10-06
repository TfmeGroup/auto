import { created, ok, readBody, route } from '@/server/http/route';
import { checkInBooking } from '@/server/jobcards/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: ['booking.edit'], write: true }, async ({ req, ctx, params }) => {
  const r = await checkInBooking(ctx, params.id ?? '', await readBody(req)); return r.created ? created(r.job) : ok(r.job);
});
