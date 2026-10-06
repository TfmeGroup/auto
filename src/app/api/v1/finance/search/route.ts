import { ok, rawQuery, route } from '@/server/http/route';
import { searchFinance } from '@/server/finance/search';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ["invoice.view","quote.view","payment.view","credit_note.view"] }, async ({ req, ctx }) => {
  return ok(await searchFinance(ctx, rawQuery(req)));
});
