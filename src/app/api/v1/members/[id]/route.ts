import { ok, readJson, route } from '@/server/http/route';
import { changeMemberRole, changeRoleSchema, revokeInvitation } from '@/server/memberships/service';
import { parseOrThrow, uuidSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'employee.manage_roles', write: true }, async ({ req, ctx, params }) => {
  await changeMemberRole(ctx, parseOrThrow(uuidSchema, params.id), await readJson(req, changeRoleSchema));
  return ok(null);
});

/** Revoke an unclaimed invitation. */
export const DELETE = route({ access: 'business', permission: 'employee.invite', write: true }, async ({ ctx, params }) => {
  await revokeInvitation(ctx, parseOrThrow(uuidSchema, params.id));
  return ok(null);
});
