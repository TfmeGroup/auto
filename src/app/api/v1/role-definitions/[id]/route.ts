import { ok, readBody, route } from '@/server/http/route';
import { archiveRole, updateRole } from '@/server/roles/service';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'employee.manage_roles', feature: 'custom_roles', write: true }, async ({ req, ctx, params }) =>
  ok(await updateRole(ctx, params.id ?? '', await readBody(req))),
);

/** Archive (never delete) a custom role that nobody is using any more. */
export const DELETE = route({ access: 'business', permission: 'employee.manage_roles', write: true }, async ({ ctx, params }) => {
  await archiveRole(ctx, params.id ?? '');
  return ok(null);
});
