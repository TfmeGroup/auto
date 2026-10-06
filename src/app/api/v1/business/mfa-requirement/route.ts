import { ok, readBody, route } from '@/server/http/route';
import { setMfaRequirement } from '@/server/businesses/service';

export const dynamic = 'force-dynamic';

// Plan entitlement (mfa_enforcement) is enforced by the route wrapper AND again in the service.
export const POST = route({ access: 'business', permission: 'settings.manage_security', feature: 'mfa_enforcement', write: true }, async ({ req, ctx }) =>
  ok(await setMfaRequirement(ctx, await readBody(req))),
);
