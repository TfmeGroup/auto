import { ok, readBody, route } from '@/server/http/route';
import { setCategoryActive } from '@/server/files/categories';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'document.manage', write: true, feature: 'advanced_documents' }, async ({ req, ctx, params }) => {
  const body = (await readBody(req)) as { active?: unknown };
  return ok(await setCategoryActive(ctx, params.id ?? '', body.active !== false));
});
