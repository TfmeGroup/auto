import { created, ok, readBody, route } from '@/server/http/route';
import { createSavedReport, listSavedReports } from '@/server/reports/saved';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.view' }, async ({ ctx }) => ok(await listSavedReports(ctx)));
export const POST = route({ access: 'business', permission: 'report.view', write: true }, async ({ req, ctx }) => created(await createSavedReport(ctx, await readBody(req))));
