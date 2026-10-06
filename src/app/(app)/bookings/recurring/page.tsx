import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { RecurringForm } from '@/components/workshop/BookingExtras';
import { listRecurringRules } from '@/server/bookings/extras';
import { getWorkshopLookups } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { minutesToHhmm } from '@/lib/tz';

export const metadata: Metadata = { title: 'Recurring bookings' };
export const dynamic = 'force-dynamic';

export default async function RecurringPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'booking.view');
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const [rules, lookups] = await Promise.all([listRecurringRules(ctx), getWorkshopLookups(ctx)]);
  return (
    <>
      <PageHeader title="Recurring bookings" description="Fleet and scheduled maintenance. Every date is its own booking." />
      <div className="grid gap-4 lg:grid-cols-[1fr_28rem]">
        <div>
          {rules.length === 0 ? (
            <EmptyState title="No recurring series">Create one for a fleet customer or a regular service programme.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {rules.map((r) => (
                <li key={r.id}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold">{r.serviceLabel}</p>
                        <p className="text-sm text-muted">
                          {r.frequency === 'WEEKLY' ? `Every ${r.intervalCount === 1 ? 'week' : `${r.intervalCount} weeks`}` : `Every ${r.intervalCount === 1 ? 'month' : `${r.intervalCount} months`}`} at {minutesToHhmm(r.startMinute)} from {r.startDate}
                          {r.endDate ? ` until ${r.endDate.toISOString().slice(0, 10)}` : r.occurrences ? ` (${r.occurrences} times)` : ''}
                        </p>
                        <p className="text-sm">{r.upcomingBookings} upcoming booking{r.upcomingBookings === 1 ? '' : 's'} · <Link href={`/bookings?view=list&q=${encodeURIComponent(r.serviceLabel)}`} className="text-brand-700 hover:underline">see them</Link></p>
                      </div>
                      <Badge tone={r.status === 'ACTIVE' ? 'ok' : 'neutral'}>{r.status.toLowerCase()}</Badge>
                    </div>
                    {r.status === 'ACTIVE' && can('booking.cancel') && ctx.subscription.canWrite && (
                      <div className="mt-2"><ActionButton label="Stop series" variant="ghost" path={`/api/v1/bookings/recurring/${r.id}/cancel`} body={{}} confirm="Stop this series and cancel its future bookings?" /></div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
        {can('booking.create') && ctx.subscription.canWrite && (
          <Card>
            <h2 className="mb-3 text-base font-semibold">New recurring series</h2>
            <RecurringForm lookups={lookups} perms={{ createCustomer: can('customer.create'), createVehicle: can('vehicle.create') }} />
          </Card>
        )}
      </div>
    </>
  );
}
