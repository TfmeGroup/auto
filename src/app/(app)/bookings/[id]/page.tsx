import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { Row } from '@/components/workshop/layout';
import { BookingCheckIn } from '@/components/workshop/BookingExtras';
import { BookingStatusBadge, JobStatusBadge } from '@/components/workshop/badges';
import { getBooking } from '@/server/bookings/service';
import { getWorkshopLookups, getRules, resolveMemberNames } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';

export const metadata: Metadata = { title: 'Booking' };
export const dynamic = 'force-dynamic';

const EVENT: Record<string, string> = { created: 'Booked', rescheduled: 'Rescheduled', cancelled: 'Cancelled', status_changed: 'Status changed', checked_in: 'Checked in', technician_changed: 'Technician changed' };

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'booking.view');
  const { id } = await params;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const fmt = (d: Date) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);

  let b;
  try {
    b = await getBooking(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const live = ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'RESCHEDULED'].includes(b.status);
  const canWrite = ctx.subscription.canWrite;
  const [lookups, rules] = await Promise.all([getWorkshopLookups(ctx), getRules(ctx)]);
  const names = await resolveMemberNames(ctx, b.events.flatMap((e) => [e.fromTechnicianMembershipId, e.toTechnicianMembershipId]));

  return (
    <>
      <PageHeader
        title={`${b.bookingNumber} · ${b.serviceLabel}`}
        description={`${fmt(b.startsAt)} · ${b.durationMin} min`}
        actions={b.job ? <Link href={`/jobs/${b.job.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Open job {b.job.jobNumber}</Link> : undefined}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2"><BookingStatusBadge status={b.status} />{b.isWalkIn && <span className="text-xs text-muted">Walk-in</span>}{b.job && <JobStatusBadge status={b.job.status} />}</div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-base font-semibold">Details</h2>
          <dl className="divide-y divide-line">
            <Row label="Customer"><Link href={`/customers/${b.customer.id}`} className="text-brand-700 hover:underline">{b.customer.name}</Link> <span className="text-muted">{b.customer.mobile}</span></Row>
            <Row label="Vehicle"><Link href={`/vehicles/${b.vehicle.id}`} className="text-brand-700 hover:underline">{[b.vehicle.registration, b.vehicle.make, b.vehicle.model].filter(Boolean).join(' · ')}</Link></Row>
            <Row label="Service">{b.serviceLabel}</Row>
            <Row label="When">{fmt(b.startsAt)} – {formatDateTime(b.endsAt, ctx.business.timezone, ctx.business.locale).split(', ').pop()}</Row>
            <Row label="Technician">{b.technicianName}</Row>
            <Row label="Bay">{b.bayName}</Row>
            <Row label="Customer’s notes"><span className="whitespace-pre-wrap">{b.customerNotes}</span></Row>
            <Row label="Internal notes"><span className="whitespace-pre-wrap">{b.internalNotes}</span></Row>
            {b.status === 'CANCELLED' && <Row label="Cancelled">{b.cancelReason ?? 'No reason given'}</Row>}
          </dl>
        </Card>

        <div className="space-y-4">
          {live && can('booking.edit') && can('job.create') && canWrite && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Vehicle has arrived</h2>
              <BookingCheckIn bookingId={b.id} requireSignature={rules.requireCheckInSignature} currentMileage={b.vehicle.mileageKm} />
            </Card>
          )}
          {live && canWrite && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Actions</h2>
              <div className="flex flex-wrap gap-2">
                {b.status === 'REQUESTED' && can('booking.edit') && <ActionButton label="Confirm booking" variant="primary" path={`/api/v1/bookings/${b.id}/status`} body={{ status: 'CONFIRMED' }} />}
                {['CONFIRMED', 'RESCHEDULED'].includes(b.status) && can('booking.edit') && <ActionButton label="Mark reminder sent" variant="secondary" path={`/api/v1/bookings/${b.id}/status`} body={{ status: 'REMINDER_SENT' }} />}
                {can('booking.edit') && b.startsAt.getTime() <= Date.now() && <ActionButton label="No-show" variant="secondary" path={`/api/v1/bookings/${b.id}/status`} body={{ status: 'NO_SHOW' }} confirm="Record that the customer did not arrive?" />}
              </div>
              {can('booking.reschedule') && (
                <details className="mt-3">
                  <summary className="min-h-11 cursor-pointer text-sm font-semibold leading-[2.75rem]">Reschedule</summary>
                  <InlineForm
                    endpoint={`/api/v1/bookings/${b.id}/reschedule`}
                    submitLabel="Move booking"
                    variant="secondary"
                    resetOnSuccess={false}
                    fields={[
                      { name: 'date', label: 'New date', type: 'date', required: true },
                      { name: 'time', label: 'New time', type: 'time', required: true },
                      { name: 'technicianMembershipId', label: 'Technician', type: 'select', defaultValue: b.technicianMembershipId ?? '', options: [{ value: '', label: 'Not assigned' }, ...lookups.technicians.map((t) => ({ value: t.membershipId, label: t.name }))] },
                      ...(lookups.bays.length ? [{ name: 'bayId', label: 'Bay', type: 'select' as const, defaultValue: b.bayId ?? '', options: [{ value: '', label: 'No bay' }, ...lookups.bays.map((x) => ({ value: x.id, label: x.name }))] }] : []),
                      { name: 'reason', label: rules.requireRescheduleReason ? 'Reason (required)' : 'Reason (optional)', required: rules.requireRescheduleReason, span: 'full' },
                    ]}
                  />
                  {rules.notifyCustomerReschedule && b.customer.email && <p className="mt-2 text-xs text-muted">The customer will be emailed the new time.</p>}
                </details>
              )}
              {can('booking.cancel') && (
                <details className="mt-1">
                  <summary className="min-h-11 cursor-pointer text-sm font-semibold leading-[2.75rem] text-danger">Cancel this booking</summary>
                  <Alert tone="warn">Cancelling frees the time slot. The booking and its history are kept.</Alert>
                  <InlineForm endpoint={`/api/v1/bookings/${b.id}/cancel`} submitLabel="Cancel booking" variant="danger" resetOnSuccess={false} className="mt-2" fields={[{ name: 'reason', label: 'Reason', span: 'full' }]} />
                </details>
              )}
            </Card>
          )}
        </div>
      </div>

      <Card className="mt-4">
        <h2 className="mb-2 text-base font-semibold">History</h2>
        <ol className="space-y-2 text-sm">
          {b.events.map((e) => (
            <li key={e.id}>
              <span className="font-medium">{EVENT[e.type] ?? e.type}</span>
              {e.fromStartsAt && e.toStartsAt && e.type === 'rescheduled' ? ` from ${fmt(e.fromStartsAt)} to ${fmt(e.toStartsAt)}` : e.toStartsAt && e.type === 'created' ? ` for ${fmt(e.toStartsAt)}` : ''}
              {e.type === 'technician_changed' ? `: ${names.get(e.fromTechnicianMembershipId ?? '') ?? 'nobody'} → ${names.get(e.toTechnicianMembershipId ?? '') ?? 'nobody'}` : ''}
              {e.fromStatus && e.toStatus && e.type !== 'rescheduled' ? ` (${e.fromStatus.toLowerCase().replace('_', ' ')} → ${e.toStatus.toLowerCase().replace('_', ' ')})` : ''}
              {e.reason ? ` — ${e.reason}` : ''}
              <span className="block text-xs text-muted">{fmt(e.createdAt)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
