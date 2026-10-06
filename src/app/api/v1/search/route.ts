import { ok, route } from '@/server/http/route';
import { globalSearch } from '@/server/search/service';

export const dynamic = 'force-dynamic';

// Any member may search; each module's results are gated by that module's own permission.
export const GET = route(
  {
    access: 'business',
    permission: [
      'customer.view', 'vehicle.view', 'job.view', 'invoice.view', 'quote.view',
      'inventory.view', 'inventory.view', 'employee.view', 'document.view',
    ],
    rateLimit: { name: 'search', limit: 120, windowSec: 60 },
  },
  async ({ req, ctx }) => ok(await globalSearch(ctx, Object.fromEntries(new URL(req.url).searchParams))),
);
