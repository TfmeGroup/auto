import { created, ok, readBody, route } from '@/server/http/route';
import { listRecurringRules, createRecurringSeries } from '@/server/bookings/extras';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'booking.view' }, async ({ ctx }) =>
  ok(await listRecurringRules(ctx)),
);

export const POST = route({ access: 'business', permission: 'booking.create', write: true }, async ({ req, ctx }) =>
  created(await createRecurringSeries(ctx, await readBody(req))),
);
