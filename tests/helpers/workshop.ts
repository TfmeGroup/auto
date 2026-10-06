import { createCustomer } from '@/server/customers/service';
import { createVehicle } from '@/server/vehicles/service';
import { addDays, todayIso, weekdayOf } from '@/lib/tz';
import { prisma } from '@/server/db/client';
import { setActiveBusiness } from '@/server/auth/session';
import { createRole } from '@/server/roles/service';
import type { Permission } from '@/server/permissions/catalog';
import { customerInput } from './customers';
import { businessContext, createUser, userContext, type TestWorkspace } from './factory';

let n = 0;

/** A member whose role grants exactly these permissions (a custom role), with a ready-to-use context. */
export async function memberWithPermissions(ws: TestWorkspace, permissions: Permission[]) {
  const role = await createRole(ws.ctx, { name: `Custom role ${++n} ${Date.now()}`, permissions });
  const user = await createUser({ name: 'Custom Member' });
  await prisma().membership.create({ data: { businessId: ws.businessId, userId: user.id, roleId: role.id, status: 'ACTIVE', joinedAt: new Date() } });
  const uctx = await userContext(user);
  await setActiveBusiness(prisma(), uctx.sessionId, ws.businessId);
  return { user, ctx: await businessContext(user) };
}

/** A customer with one vehicle in the caller's business. */
export async function seedCustomerVehicle(ws: TestWorkspace, label = 'Case') {
  const ctx = ws.ctx;
  const i = ++n;
  const customer = await createCustomer(ctx, customerInput(`${label} Customer${i}`, { email: `c${i}.${Date.now()}@example.test` }));
  const vehicle = await createVehicle(ctx, {
    customerId: customer.id,
    registration: `T${String(i).padStart(3, '0')} ${label.slice(0, 2).toUpperCase()} GP`,
    make: 'Toyota', model: 'Hilux', year: 2019, mileageKm: 50_000,
  });
  return { customer, vehicle };
}

/** The ISO date of the `nth` upcoming Monday-Friday (workshops are open 08:00-17:00 on weekdays by default), in business time. */
export function nextWeekday(nth = 1, tz = 'Africa/Johannesburg'): string {
  let d = todayIso(tz);
  let found = 0;
  while (found < nth) {
    d = addDays(d, 1);
    const wd = weekdayOf(d);
    if (wd >= 1 && wd <= 5) found++;
  }
  return d;
}

export const nextSaturday = (tz = 'Africa/Johannesburg') => {
  let d = addDays(todayIso(tz), 1);
  while (weekdayOf(d) !== 6) d = addDays(d, 1);
  return d;
};
