import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { changeMemberStatus } from '@/server/memberships/service';
import { parseOrThrow, uuidSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'employee.suspend', write: true }, async ({ req, ctx, params }) => {
  const { action } = await readJson(req, z.object({ action: z.enum(['suspend', 'reactivate', 'remove']) }));
  await changeMemberStatus(ctx, parseOrThrow(uuidSchema, params.id), action);
  return ok(null);
});
