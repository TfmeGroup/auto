import { ok, readBody, route } from '@/server/http/route';
import { deleteSchedule, updateSchedule } from '@/server/reports/schedules';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'report.manage_scheduled', write: true }, async ({ req, ctx, params }) => ok(await updateSchedule(ctx, params.id ?? '', await readBody(req))));
export const DELETE = route({ access: 'business', permission: 'report.manage_scheduled', write: true }, async ({ ctx, params }) => ok(await deleteSchedule(ctx, params.id ?? '')));
