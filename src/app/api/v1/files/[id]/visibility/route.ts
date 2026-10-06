import { ok, readBody, route } from '@/server/http/route';
import { setFileVisibility } from '@/server/files/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'document.edit', write: true }, async ({ req, ctx, params }) => {
  const body = (await readBody(req)) as { visibility?: unknown };
  return ok(await setFileVisibility(ctx, params.id ?? '', body.visibility));
});
