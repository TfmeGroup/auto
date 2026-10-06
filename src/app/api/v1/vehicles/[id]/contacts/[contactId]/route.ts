import { ok, route } from '@/server/http/route';
import { removeVehicleContact } from '@/server/vehicles/service';

export const dynamic = 'force-dynamic';

export const DELETE = route({ access: 'business', permission: 'vehicle.edit', write: true }, async ({ ctx, params }) =>
  ok(await removeVehicleContact(ctx, params.id ?? '', params.contactId ?? '').then(() => null)),
);
