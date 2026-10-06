import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, Pagination } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { WaitingForm } from '@/components/workshop/BookingExtras';
import { listWaitingEntries } from '@/server/bookings/extras';
import { getWorkshopLookups } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDate } from '@/lib/format';
import { minutesToHhmm } from '@/lib/tz';

export const metadata: Metadata = { title: 'Waiting list' };
export const dynamic = 'force-dynamic';

export default async function WaitingListPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'booking.view');
  const sp = await searchParams;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const [{ items, meta }, lookups] = await Promise.all([listWaitingEntries(ctx, { page: sp.page, pageSize: 20 }), getWorkshopLookups(ctx)]);
  const canWrite = ctx.subscription.canWrite;
  return (
    <>
      <PageHeader title="Waiting list" description="Customers who want the next gap. Nobody is booked automatically: you choose the slot." />
      <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <div>
          {items.length === 0 ? (
            <EmptyState title="Nobody is waiting">Add a customer who wants a slot when one opens up.</EmptyState>
          ) : (
            <>
              <ul className="space-y-2">
                {items.map((e) => (
                  <li key={e.id}>
                    <Card>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold">{e.customer ? <Link href={`/customers/${e.customer.id}`} className="hover:underline">{e.customer.name}</Link> : 'Customer'}</p>
                          <p className="text-sm">{e.serviceLabel}{e.vehicle ? ` · ${[e.vehicle.registration, e.vehicle.model].filter(Boolean).join(' ')}` : ''}</p>
                          <p className="text-xs text-muted">
                            {[e.preferredDate ? `Prefers ${formatDate(e.preferredDate, 'UTC', ctx.business.locale)}` : null, e.preferredStartMinute !== null && e.preferredEndMinute !== null ? `${minutesToHhmm(e.preferredStartMinute)}–${minutesToHhmm(e.preferredEndMinute)}` : null, e.contactPreference ? `contact by ${e.contactPreference.toLowerCase()}` : null, e.customer?.mobile].filter(Boolean).join(' · ')}
                          </p>
                          {e.notes && <p className="mt-1 text-sm text-muted">{e.notes}</p>}
                        </div>
                        <Badge tone={e.status === 'CONTACTED' ? 'brand' : e.status === 'BOOKED' ? 'ok' : e.status === 'CANCELLED' ? 'neutral' : 'warn'}>{e.status.toLowerCase()}</Badge>
                      </div>
                      {['WAITING', 'CONTACTED'].includes(e.status) && canWrite && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {can('booking.create') && e.vehicle && <Link href={`/bookings/waiting-list/${e.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Book a slot</Link>}
                          {can('booking.edit') && e.status === 'WAITING' && <ActionButton label="Mark contacted" variant="secondary" method="PATCH" path={`/api/v1/bookings/waiting-list/${e.id}`} body={{ status: 'CONTACTED' }} />}
                          {can('booking.edit') && <ActionButton label="Remove" variant="ghost" method="PATCH" path={`/api/v1/bookings/waiting-list/${e.id}`} body={{ status: 'CANCELLED' }} confirm="Remove this customer from the waiting list?" />}
                        </div>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>
              <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => `/bookings/waiting-list?page=${p}`} />
            </>
          )}
        </div>
        {can('booking.create') && canWrite && (
          <Card>
            <h2 className="mb-3 text-base font-semibold">Add to the waiting list</h2>
            <WaitingForm lookups={lookups} perms={{ createCustomer: can('customer.create'), createVehicle: can('vehicle.create') }} />
          </Card>
        )}
      </div>
    </>
  );
}
