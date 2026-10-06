import type { Metadata } from 'next';
import { Badge, Card, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { HoursEditor } from '@/components/workshop/HoursEditor';
import { getRules, getTechnicianSchedule, getWorkshopHours, getWorkshopLookups, listBays, listServiceTypes, listTimeOff } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Workshop settings' };
export const dynamic = 'force-dynamic';

export default async function WorkshopSettingsPage() {
  const ctx = await requireBusiness();
  if (!(['booking.manage', 'booking.view', 'job.view'] as const).some((p) => ctx.permissions.has(p))) assertCan(ctx, 'booking.manage');
  const can = ctx.permissions.has('booking.manage') && ctx.subscription.canWrite;
  const [types, bays, rules, hours, lookups, timeOff] = await Promise.all([
    listServiceTypes(ctx, { includeArchived: true }), listBays(ctx, { includeArchived: true }), getRules(ctx), getWorkshopHours(ctx), getWorkshopLookups(ctx), listTimeOff(ctx),
  ]);
  const schedules = await Promise.all(lookups.technicians.map(async (t) => ({ ...t, hours: await getTechnicianSchedule(ctx, t.membershipId) })));
  const fmt = (d: Date) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);

  return (
    <>
      <PageHeader title="Bookings and workshop" description="Services, bays, opening hours and the rules bookings follow." />
      {!ctx.permissions.has('booking.manage') && <p className="mb-3 text-sm text-muted">You can view these settings but not change them.</p>}
      <div className="space-y-4">
        <Card>
          <h2 className="mb-1 text-base font-semibold">Services</h2>
          <p className="mb-3 text-xs text-muted">The default duration is used for new bookings. Changing the length of one booking never changes it here.</p>
          <ul className="divide-y divide-line">
            {types.map((t) => (
              <li key={t.id} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t.name} <span className="font-normal text-muted">· {t.defaultDurationMin} min</span> {t.status === 'ARCHIVED' && <Badge>Archived</Badge>}</span>
                  {can && <ActionButton label={t.status === 'ARCHIVED' ? 'Restore' : 'Archive'} variant="ghost" method="PATCH" path={`/api/v1/workshop/service-types/${t.id}`} body={{ archived: t.status !== 'ARCHIVED' }} />}
                </div>
                {can && t.status === 'ACTIVE' && (
                  <details><summary className="min-h-11 cursor-pointer text-xs font-medium text-brand-700 leading-[2.75rem]">Edit</summary>
                    <InlineForm endpoint={`/api/v1/workshop/service-types/${t.id}`} method="PATCH" submitLabel="Save" variant="secondary" resetOnSuccess={false} fields={[{ name: 'name', label: 'Name', defaultValue: t.name }, { name: 'defaultDurationMin', label: 'Default duration (minutes)', type: 'number', defaultValue: String(t.defaultDurationMin) }]} />
                  </details>
                )}
              </li>
            ))}
          </ul>
          {can && (
            <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Add a service</summary>
              <InlineForm endpoint="/api/v1/workshop/service-types" submitLabel="Add service" fields={[{ name: 'name', label: 'Name', required: true }, { name: 'defaultDurationMin', label: 'Default duration (minutes)', type: 'number', required: true, defaultValue: '60' }]} />
            </details>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 text-base font-semibold">Service bays</h2>
          <p className="mb-3 text-xs text-muted">A bay holds one booking at a time. With bays set up and no other limit, the number of bookings at once cannot exceed the number of bays.</p>
          {bays.length === 0 ? <p className="text-sm text-muted">No bays yet.</p> : (
            <ul className="divide-y divide-line">
              {bays.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span className="font-medium">{b.name} {b.status === 'ARCHIVED' && <Badge>Archived</Badge>}</span>
                  {can && <ActionButton label={b.status === 'ARCHIVED' ? 'Restore' : 'Archive'} variant="ghost" method="PATCH" path={`/api/v1/workshop/bays/${b.id}`} body={{ archived: b.status !== 'ARCHIVED' }} />}
                </li>
              ))}
            </ul>
          )}
          {can && (
            <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Add a bay</summary>
              <InlineForm endpoint="/api/v1/workshop/bays" submitLabel="Add bay" fields={[{ name: 'name', label: 'Name', required: true, placeholder: 'Bay 1' }]} />
            </details>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-base font-semibold">Booking and check-in rules</h2>
          {can ? (
            <InlineForm endpoint="/api/v1/workshop/rules" method="PATCH" submitLabel="Save rules" variant="secondary" resetOnSuccess={false} fields={[
              { name: 'allowTechnicianOverlap', label: 'Allow a technician to be booked into overlapping appointments', type: 'checkbox', defaultValue: rules.allowTechnicianOverlap },
              { name: 'maxConcurrentJobs', label: 'Most bookings running at the same time (leave empty for no limit)', type: 'number', defaultValue: rules.maxConcurrentJobs !== null ? String(rules.maxConcurrentJobs) : '', span: 'full' },
              { name: 'requireCheckInSignature', label: 'Require the customer’s confirmation at check-in', type: 'checkbox', defaultValue: rules.requireCheckInSignature },
              { name: 'requireRescheduleReason', label: 'Require a reason when a booking is rescheduled', type: 'checkbox', defaultValue: rules.requireRescheduleReason },
              { name: 'notifyCustomerReschedule', label: 'Email the customer when their booking is moved', type: 'checkbox', defaultValue: rules.notifyCustomerReschedule },
              { name: 'notifyCustomerCancel', label: 'Email the customer when their booking is cancelled', type: 'checkbox', defaultValue: rules.notifyCustomerCancel },
              { name: 'bufferMinutes', label: 'Gap kept between appointments for the same technician or bay (minutes)', type: 'number', defaultValue: String(rules.bufferMinutes), span: 'full' },
              { name: 'minLeadMinutes', label: 'Shortest notice for a booking (minutes; a manager can override)', type: 'number', defaultValue: String(rules.minLeadMinutes), span: 'full' },
              { name: 'maxDailyBookings', label: 'Most bookings in one day (leave empty for no limit)', type: 'number', defaultValue: rules.maxDailyBookings !== null ? String(rules.maxDailyBookings) : '', span: 'full' },
              { name: 'cancelWindowHours', label: 'Cancelling this close to the start needs a calendar manager (hours; 0 for no rule)', type: 'number', defaultValue: String(rules.cancelWindowHours), span: 'full' },
              { name: 'allowWalkIns', label: 'Allow walk-ins (jobs opened without a booking)', type: 'checkbox', defaultValue: rules.allowWalkIns },
              { name: 'waitingListEnabled', label: 'Use the waiting list', type: 'checkbox', defaultValue: rules.waitingListEnabled },
            ]} />
          ) : (
            <ul className="list-disc pl-5 text-sm">
              <li>Overlapping technician appointments: {rules.allowTechnicianOverlap ? 'allowed' : 'not allowed'}</li>
              <li>Most bookings at once: {rules.maxConcurrentJobs ?? 'no limit'}</li>
              <li>Customer confirmation at check-in: {rules.requireCheckInSignature ? 'required' : 'optional'}</li>
              <li>Gap between appointments: {rules.bufferMinutes} min · shortest notice: {rules.minLeadMinutes} min · most per day: {rules.maxDailyBookings ?? 'no limit'}</li>
              <li>Walk-ins: {rules.allowWalkIns ? 'allowed' : 'switched off'} · waiting list: {rules.waitingListEnabled ? 'on' : 'off'} · cancellation window: {rules.cancelWindowHours ? rules.cancelWindowHours + ' h' : 'none'}</li>
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 text-base font-semibold">Opening hours</h2>
          {can ? <HoursEditor endpoint="/api/v1/workshop/hours" initial={hours} emptyMeans="Tick no days to take away the opening-hours rule altogether (bookings are then allowed at any time)." /> : <p className="text-sm text-muted">{hours.length ? 'Set.' : 'No opening hours set.'}</p>}
        </Card>

        <Card>
          <h2 className="mb-1 text-base font-semibold">Technician hours</h2>
          <p className="mb-3 text-xs text-muted">A technician with no hours of their own follows the opening hours above.</p>
          {schedules.length === 0 ? <p className="text-sm text-muted">No technicians yet. Invite team members with a job role.</p> : (
            <ul className="space-y-1">
              {schedules.map((t) => (
                <li key={t.membershipId} className="rounded-lg border border-line px-3">
                  <details>
                    <summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem]">{t.name} <span className="font-normal text-muted">· {t.hours.length ? 'own hours' : 'follows opening hours'}</span></summary>
                    <div className="pb-3">{can ? <HoursEditor endpoint={`/api/v1/workshop/technicians/${t.membershipId}/schedule`} initial={t.hours} emptyMeans="Tick no days to follow the workshop’s opening hours." /> : null}</div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 text-base font-semibold">Leave and days off</h2>
          {timeOff.length === 0 ? <p className="text-sm text-muted">No upcoming time off.</p> : (
            <ul className="divide-y divide-line text-sm">
              {timeOff.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span><span className="font-medium">{t.technician}</span> · {t.kind.toLowerCase().replace('_', ' ')} · {fmt(t.startsAt)} → {fmt(t.endsAt)}{t.reason ? ` · ${t.reason}` : ''}</span>
                  {can && <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/workshop/time-off/${t.id}`} confirm="Remove this time off?" />}
                </li>
              ))}
            </ul>
          )}
          {can && lookups.technicians.length > 0 && (
            <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Add leave</summary>
              <InlineForm endpoint="/api/v1/workshop/time-off" submitLabel="Add leave" fields={[
                { name: 'membershipId', label: 'Technician', type: 'select', options: lookups.technicians.map((t) => ({ value: t.membershipId, label: t.name })) },
                { name: 'kind', label: 'Type', type: 'select', defaultValue: 'LEAVE', options: [{ value: 'LEAVE', label: 'Leave' }, { value: 'DAY_OFF', label: 'Day off' }, { value: 'SICK', label: 'Sick' }, { value: 'OTHER', label: 'Other' }] },
                { name: 'startsAt', label: 'From', type: 'datetime-local', required: true, parse: 'iso' },
                { name: 'endsAt', label: 'Until', type: 'datetime-local', required: true, parse: 'iso' },
                { name: 'reason', label: 'Reason (optional)', span: 'full' },
              ]} />
            </details>
          )}
        </Card>
      </div>
    </>
  );
}
