import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listTimeOff, addTimeOff } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['booking.view', 'job.view', 'booking.manage'] }, async ({ req, ctx }) =>
  ok(await listTimeOff(ctx, { membershipId: rawQuery(req).membershipId })),
);

export const POST = route({ access: 'business', permission: 'booking.manage', write: true }, async ({ req, ctx }) =>
  created(await addTimeOff(ctx, await readBody(req))),
);
