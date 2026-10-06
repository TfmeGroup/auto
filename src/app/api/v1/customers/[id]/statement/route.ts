import { ok, rawQuery, route } from '@/server/http/route';
import { getStatement } from '@/server/finance/statements';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "invoice.view" }, async ({ req, ctx, params }) => {
  return ok(await getStatement(ctx, params.id ?? '', rawQuery(req)));
});
