import { ok, route } from '@/server/http/route';
import { getCreditNote } from '@/server/finance/creditnotes';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "credit_note.view" }, async ({ ctx, params }) => {
  return ok(await getCreditNote(ctx, params.id ?? ''));
});
