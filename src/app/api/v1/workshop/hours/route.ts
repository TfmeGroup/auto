import { ok, readBody, route } from '@/server/http/route';
import { getWorkshopHours, setWorkshopHours } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['booking.view', 'job.view', 'booking.manage'] }, async ({ ctx }) =>
  ok(await getWorkshopHours(ctx)),
);

export const PUT = route({ access: 'business', permission: 'booking.manage', write: true }, async ({ req, ctx }) =>
  ok(await setWorkshopHours(ctx, await readBody(req))),
);
