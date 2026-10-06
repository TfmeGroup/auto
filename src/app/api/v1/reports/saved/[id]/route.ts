import { ok, readBody, route } from '@/server/http/route';
import { archiveSavedReport, getSavedReport, updateSavedReport } from '@/server/reports/saved';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'report.view' }, async ({ ctx, params }) => ok(await getSavedReport(ctx, params.id ?? '')));
export const PATCH = route({ access: 'business', permission: 'report.view', write: true }, async ({ req, ctx, params }) => ok(await updateSavedReport(ctx, params.id ?? '', await readBody(req))));
export const DELETE = route({ access: 'business', permission: 'report.view', write: true }, async ({ ctx, params }) => ok(await archiveSavedReport(ctx, params.id ?? '')));
