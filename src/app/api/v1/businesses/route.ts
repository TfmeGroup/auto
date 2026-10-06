import { created, readBody, route } from '@/server/http/route';
import { createBusiness } from '@/server/businesses/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'user' }, async ({ req, ctx }) => {
  const b = await createBusiness(ctx, await readBody(req));
  return created({ id: b.id, name: b.name });
});
