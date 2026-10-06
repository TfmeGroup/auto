import { ok, readBody, route } from '@/server/http/route';
import { getTechnicianSchedule, setTechnicianSchedule } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['booking.view', 'job.view', 'booking.manage'] }, async ({ ctx, params }) =>
  ok(await getTechnicianSchedule(ctx, params.membershipId ?? '')),
);

export const PUT = route({ access: 'business', permission: 'booking.manage', write: true }, async ({ req, ctx, params }) =>
  ok(await setTechnicianSchedule(ctx, params.membershipId ?? '', await readBody(req)).then(() => null)),
);
