import { ok, route } from '@/server/http/route';
import { availableReports } from '@/server/reports/run';

export const dynamic = 'force-dynamic';

/** The reports this person may open (with a "locked" flag for those their plan does not include). */
export const GET = route({ access: 'business', permission: 'report.view' }, async ({ ctx }) => ok(availableReports(ctx)));
