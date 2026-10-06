import { ok, readBody, route } from '@/server/http/route';
import { setWaitingStatus } from '@/server/bookings/extras';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'booking.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await setWaitingStatus(ctx, params.id ?? '', (await readBody(req) as { status?: unknown }).status)),
);
