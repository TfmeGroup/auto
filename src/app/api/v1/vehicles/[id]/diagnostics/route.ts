import { ok, route } from '@/server/http/route';
import { listVehicleDiagnostics } from '@/server/jobcards/work';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'vehicle.view' }, async ({ ctx, params }) =>
  ok(await listVehicleDiagnostics(ctx, params.id ?? '')),
);
