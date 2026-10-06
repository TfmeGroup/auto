import { created, ok, readBody, route } from '@/server/http/route';
import { createLocation, listLocations } from '@/server/locations/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'settings.view' }, async ({ ctx }) => ok(await listLocations(ctx)));

// The second and later locations need the multi_location entitlement (checked in the service) and room in the plan.
export const POST = route({ access: 'business', permission: ['settings.edit', 'location.manage'], write: true }, async ({ req, ctx }) =>
  created(await createLocation(ctx, await readBody(req))),
);
