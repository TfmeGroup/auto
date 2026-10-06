import { created, ok, rawQuery, readBody, route } from '@/server/http/route';
import { listPayments, recordPayment } from '@/server/finance/payments';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: "payment.view" }, async ({ req, ctx }) => {
  const r = await listPayments(ctx, rawQuery(req)); return ok(r.items, r.meta);
});

export const POST = route({ access: 'business', permission: "payment.create", write: true }, async ({ req, ctx }) => {
  const r = await recordPayment(ctx, await readBody(req)); return r.alreadyRecorded ? ok(r) : created(r);
});
