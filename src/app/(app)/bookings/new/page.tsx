import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { BookingForm } from '@/components/workshop/BookingForm';
import { getCustomer } from '@/server/customers/service';
import { getWorkshopLookups } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New booking' };
export const dynamic = 'force-dynamic';

export default async function NewBookingPage({ searchParams }: { searchParams: Promise<{ customerId?: string; vehicleId?: string; date?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'booking.create');
  const sp = await searchParams;
  const [lookups, customer] = await Promise.all([getWorkshopLookups(ctx), sp.customerId ? getCustomer(ctx, sp.customerId).catch(() => null) : null]);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  return (
    <>
      <PageHeader title="New booking" description="Pick the customer and vehicle, the service and a time." />
      <Card>
        <BookingForm
          lookups={lookups}
          customer={customer ? { id: customer.id, name: customer.name, customerNumber: customer.customerNumber, mobile: customer.mobile } : null}
          vehicleId={customer ? sp.vehicleId : undefined}
          date={sp.date}
          perms={{ createCustomer: can('customer.create'), createVehicle: can('vehicle.create'), editDuration: can('booking.edit'), manageCalendar: can('booking.manage') }}
        />
      </Card>
    </>
  );
}
