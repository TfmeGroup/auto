import { ok, route } from '@/server/http/route';
import { removeJobLabour } from '@/server/jobcards/items';

export const dynamic = 'force-dynamic';

export const DELETE = route({ access: 'business', permission: 'job.edit', write: true }, async ({ ctx, params }) =>
  ok(await removeJobLabour(ctx, params.id ?? '', params.labourId ?? '').then(() => null)),
);
