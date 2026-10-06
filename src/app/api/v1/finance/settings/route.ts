import { ok, readBody, route } from '@/server/http/route';
import { getFinanceSettings, updateFinanceSettings } from '@/server/finance/settings';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "settings.view" }, async ({ ctx }) => {
  return ok(await getFinanceSettings(ctx));
});

export const PATCH = route({ access: 'business', permission: "finance.manage_settings", write: true }, async ({ req, ctx }) => {
  return ok(await updateFinanceSettings(ctx, await readBody(req)));
});
