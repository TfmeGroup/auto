import { ok, route } from '@/server/http/route';
import { serviceLine } from '@/server/settings/catalogue';

export const dynamic = 'force-dynamic';

/** A ready-made quote or invoice line for a service (its default price and VAT treatment, copied). */
export const GET = route({ access: 'business', permission: ['quote.create', 'invoice.create'] }, async ({ ctx, params }) => ok(await serviceLine(ctx, params.id ?? '')));
