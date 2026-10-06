import { z } from 'zod';
import { ok, readJson, route } from '@/server/http/route';
import { switchBusiness } from '@/server/businesses/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ req, ctx }) => {
  const { businessId } = await readJson(req, z.object({ businessId: z.uuid() }));
  await switchBusiness(ctx, businessId);
  return ok(null);
});
