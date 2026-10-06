import { ok, readBody, route } from '@/server/http/route';
import { runPreview } from '@/server/reports/saved';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'report.create_custom', feature: 'custom_reports' }, async ({ req, ctx }) => {
  const body = (await readBody(req)) as Record<string, unknown>;
  return ok(await runPreview(ctx, body, { page: Number(body.page) || 1, pageSize: Number(body.pageSize) || 50 }));
});
