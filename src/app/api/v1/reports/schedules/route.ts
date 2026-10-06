import { created, ok, readBody, route } from '@/server/http/route';
import { createSchedule, listSchedules } from '@/server/reports/schedules';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.manage_scheduled' }, async ({ ctx }) => ok(await listSchedules(ctx)));
export const POST = route({ access: 'business', permission: 'report.manage_scheduled', feature: 'scheduled_reports', write: true }, async ({ req, ctx }) => created(await createSchedule(ctx, await readBody(req))));
