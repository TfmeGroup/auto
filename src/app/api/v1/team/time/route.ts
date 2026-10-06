import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listTimeEntries, createManualEntry } from '@/server/team/time';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['time.record', 'time.view_all'], feature: 'technician_management' }, async ({ req, ctx }) => {
  const r = await listTimeEntries(ctx, rawQuery(req)); return ok({ items: r.items, totals: r.totals }, r.meta);
});

export const POST = route({ access: 'business', permission: 'time.record', write: true, feature: 'technician_management' }, async ({ req, ctx }) => {
  return created(await createManualEntry(ctx, await readBody(req)));
});
