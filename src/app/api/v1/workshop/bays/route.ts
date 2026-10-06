import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listBays, createBay } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['booking.view', 'job.view', 'booking.manage'] }, async ({ req, ctx }) =>
  ok(await listBays(ctx, { includeArchived: rawQuery(req).includeArchived === "true" })),
);

export const POST = route({ access: 'business', permission: 'booking.manage', write: true }, async ({ req, ctx }) =>
  created(await createBay(ctx, await readBody(req))),
);
