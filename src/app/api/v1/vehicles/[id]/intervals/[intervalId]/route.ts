import { ok, route } from '@/server/http/route';
import { removeInterval } from '@/server/vehicles/insights';

export const dynamic = 'force-dynamic';

export const DELETE = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ ctx, params }) =>
  ok(await removeInterval(ctx, params.id ?? '', params.intervalId ?? '').then(() => null)),
);
