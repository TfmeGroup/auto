import { ok, route } from '@/server/http/route';
import { getWorkshopLookups } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['booking.view', 'job.view', 'booking.manage'] }, async ({ ctx }) =>
  ok(await getWorkshopLookups(ctx)),
);
