import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listCreditNotes, createCreditNote } from '@/server/finance/creditnotes';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "credit_note.view" }, async ({ req, ctx }) => {
  const r = await listCreditNotes(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: "credit_note.create", write: true }, async ({ req, ctx }) => {
  return created(await createCreditNote(ctx, await readBody(req)));
});
