import { ok, route } from '@/server/http/route';
import { resendInvitation } from '@/server/memberships/service';
import { parseOrThrow, uuidSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'employee.invite', write: true }, async ({ ctx, params }) => {
  await resendInvitation(ctx, parseOrThrow(uuidSchema, params.id));
  return ok(null);
});
