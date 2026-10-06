import { created, route } from '@/server/http/route';
import { createJobFromQuote } from '@/server/finance/quotes';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: "job.create", write: true }, async ({ ctx, params }) => {
  return created(await createJobFromQuote(ctx, params.id ?? ''));
});
