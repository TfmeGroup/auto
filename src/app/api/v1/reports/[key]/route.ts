import { ok, rawQuery, route } from '@/server/http/route';
import { runReport } from '@/server/reports/run';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.view' }, async ({ req, ctx, params }) => ok(await runReport(ctx, params.key ?? '', rawQuery(req))));
