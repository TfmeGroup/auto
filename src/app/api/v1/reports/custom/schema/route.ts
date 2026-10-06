import { ok, route } from '@/server/http/route';
import { can } from '@/server/permissions/authorize';
import { schemaFor } from '@/server/reports/custom/schema';

export const dynamic = 'force-dynamic';

/** The approved reporting schema, limited to the sources and fields this person may use. */
export const GET = route({ access: 'business', permission: 'report.create_custom', feature: 'custom_reports' }, async ({ ctx }) => ok(schemaFor((p) => can(ctx, p), ctx.subscription.features)));
