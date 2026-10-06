import { ok, route } from '@/server/http/route';
import { removeTimeOff } from '@/server/workshop/service';

export const dynamic = 'force-dynamic';

export const DELETE = route({ access: 'business', permission: 'booking.manage', write: true }, async ({ ctx, params }) =>
  ok(await removeTimeOff(ctx, params.id ?? '').then(() => null)),
);
