import { created, ok, readBody, route } from '@/server/http/route';
import { createRole, listRoles } from '@/server/roles/service';
import { PERMISSIONS } from '@/server/permissions/catalog';

export const dynamic = 'force-dynamic';

/** Every role (system + this business's custom roles) with its permissions, plus the permission catalogue. */
export const GET = route({ access: 'business', permission: 'employee.view' }, async ({ ctx }) =>
  ok({ roles: await listRoles(ctx), catalogue: PERMISSIONS }),
);

/** Create a custom role. Requires the custom_roles plan entitlement. */
export const POST = route({ access: 'business', permission: 'employee.manage_roles', feature: 'custom_roles', write: true }, async ({ req, ctx }) =>
  created(await createRole(ctx, await readBody(req))),
);
