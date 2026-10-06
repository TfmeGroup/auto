import { created, ok, readBody, readQuery, route } from '@/server/http/route';
import { exportableDatasets, exportListSchema, listExports, requestExport } from '@/server/exports/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'business.export' }, async ({ req, ctx }) => {
  const r = await listExports(ctx, readQuery(req, exportListSchema));
  return ok(r.items, { ...r.meta, datasets: exportableDatasets(ctx).map((d) => ({ key: d.key, label: d.label })) });
});

// Needs the business.export permission AND the data_export plan entitlement. Generated in the background.
export const POST = route(
  { access: 'business', permission: 'business.export', feature: 'data_export' },
  async ({ req, ctx }) => created(await requestExport(ctx, await readBody(req))),
);
