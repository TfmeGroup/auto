import { created, ok, readJson, readQuery, route } from '@/server/http/route';
import { inviteMember, inviteSchema, listMembers, memberListSchema } from '@/server/memberships/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'employee.view' }, async ({ req, ctx }) => {
  const r = await listMembers(ctx, readQuery(req, memberListSchema));
  return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: 'employee.invite', write: true }, async ({ req, ctx }) =>
  created(await inviteMember(ctx, await readJson(req, inviteSchema))),
);
