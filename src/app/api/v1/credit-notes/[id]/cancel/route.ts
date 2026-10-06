import { ok, readBody, route } from '@/server/http/route';
import { cancelCreditNote } from '@/server/finance/creditnotes';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "credit_note.create", write: true }, async ({ req, ctx, params }) => {
  return ok(await cancelCreditNote(ctx, params.id ?? '', await readBody(req)));
});
