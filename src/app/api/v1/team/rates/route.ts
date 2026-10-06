import { ok, route } from '@/server/http/route';
import { getRateCard } from '@/server/team/labour';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: ['labour.view_rates', 'labour.manage_rates'] }, async ({ ctx }) => {
  return ok(await getRateCard(ctx));
});
