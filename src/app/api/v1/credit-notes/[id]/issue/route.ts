import { ok, route } from '@/server/http/route';
import { issueCreditNote } from '@/server/finance/creditnotes';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "credit_note.authorise", write: true }, async ({ ctx, params }) => {
  return ok(await issueCreditNote(ctx, params.id ?? ''));
});
