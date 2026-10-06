import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { BookingForm } from '@/components/workshop/BookingForm';
import { listWaitingEntries } from '@/server/bookings/extras';
import { getWorkshopLookups } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Book from waiting list' };
export const dynamic = 'force-dynamic';

export default async function ConvertWaitingPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'booking.create');
  const { id } = await params;
  const [{ items }, lookups] = await Promise.all([listWaitingEntries(ctx, { pageSize: 100 }), getWorkshopLookups(ctx)]);
  const entry = items.find((e) => e.id === id);
  if (!entry || !entry.customer) notFound();
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  return (
    <>
      <PageHeader title="Book from the waiting list" description={`${entry.customer.name} · ${entry.serviceLabel}`} />
      <Card>
        <BookingForm
          mode="waiting-convert"
          waitingEntryId={entry.id}
          lookups={lookups}
          customer={{ id: entry.customer.id, name: entry.customer.name, customerNumber: entry.customer.customerNumber, mobile: entry.customer.mobile }}
          vehicleId={entry.vehicleId ?? undefined}
          date={entry.preferredDate ? entry.preferredDate.toISOString().slice(0, 10) : undefined}
          perms={{ createCustomer: false, createVehicle: can('vehicle.create'), editDuration: can('booking.edit'), manageCalendar: can('booking.manage') }}
        />
      </Card>
    </>
  );
}
