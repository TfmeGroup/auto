import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { Chips, qs } from '@/components/workshop/layout';
import { BookingList } from '@/components/workshop/Lists';
import { TimeGrid, type CalBooking, type CalDay } from '@/components/workshop/TimeGrid';
import { bookingStatusLabel } from '@/components/workshop/badges';
import { BOOKING_STATUSES, getCalendar, listBookings } from '@/server/bookings/service';
import { getWorkshopHours, getWorkshopLookups } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { addDays, addMonths, localParts, minutesToHhmm, parseIsoDate, todayIso, weekStart, weekdayOf } from '@/lib/tz';

export const metadata: Metadata = { title: 'Bookings' };
export const dynamic = 'force-dynamic';

type Search = { view?: string; date?: string; page?: string; status?: string; technicianId?: string; serviceTypeId?: string; bayId?: string; locationId?: string; q?: string };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (iso: string) => {
  const p = parseIsoDate(iso)!;
  return `${DOW[weekdayOf(iso)]} ${p.day} ${MONTHS[p.month - 1]!.slice(0, 3)}`;
};

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'booking.view');
  const sp = await searchParams;
  const tz = ctx.business.timezone;
  const today = todayIso(tz);
  const view = (['day', 'week', 'month', 'list'] as const).find((v) => v === sp.view) ?? 'week';
  const date = sp.date && parseIsoDate(sp.date) ? sp.date : today;
  const status = (BOOKING_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status : undefined;
  const filters = { status, technicianId: sp.technicianId, serviceTypeId: sp.serviceTypeId, bayId: sp.bayId, locationId: sp.locationId, q: sp.q };
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);

  const [lookups, hours] = await Promise.all([getWorkshopLookups(ctx), getWorkshopHours(ctx)]);
  const openDays = new Set(hours.map((h) => h.weekday));
  const hasHours = hours.length > 0;

  const base = { view, date: date === today ? undefined : date, ...filters };
  const link = (over: Record<string, string | undefined>) => `/bookings${qs(base as Record<string, string | undefined>, over)}`;
  const step = view === 'day' ? -1 : view === 'week' ? -7 : 0;
  const prev = view === 'month' ? addMonths(date, -1) : addDays(date, step);
  const next = view === 'month' ? addMonths(date, 1) : addDays(date, -step);

  const heading =
    view === 'month' ? `${MONTHS[parseIsoDate(date)!.month - 1]} ${parseIsoDate(date)!.year}`
    : view === 'week' ? `Week of ${dayLabel(weekStart(date))}`
    : view === 'day' ? dayLabel(date) + (date === today ? ' · today' : '')
    : 'All bookings';

  const filterForm = (
    <form action="/bookings" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search">
      <input type="hidden" name="view" value={view} />
      {date !== today && <input type="hidden" name="date" value={date} />}
      <input name="q" defaultValue={sp.q} type="search" placeholder="Customer, registration or number" aria-label="Search bookings" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 md:min-h-10 lg:col-span-2" />
      <select name="technicianId" defaultValue={sp.technicianId ?? ''} aria-label="Technician" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10">
        <option value="">All technicians</option>{lookups.technicians.map((t) => <option key={t.membershipId} value={t.membershipId}>{t.name}</option>)}
      </select>
      <select name="serviceTypeId" defaultValue={sp.serviceTypeId ?? ''} aria-label="Service" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10">
        <option value="">All services</option>{lookups.serviceTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select name="status" defaultValue={status ?? ''} aria-label="Status" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10">
        <option value="">All statuses</option>{BOOKING_STATUSES.map((s) => <option key={s} value={s}>{bookingStatusLabel(s)}</option>)}
      </select>
      {lookups.bays.length > 0 && (
        <select name="bayId" defaultValue={sp.bayId ?? ''} aria-label="Bay" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10">
          <option value="">All bays</option>{lookups.bays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      )}
      {lookups.locations.length > 1 && (
        <select name="locationId" defaultValue={sp.locationId ?? ''} aria-label="Location" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10">
          <option value="">All locations</option>{lookups.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      )}
      <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply filters</button>
    </form>
  );

  const header = (
    <PageHeader
      title="Bookings"
      description="Appointments, capacity and the waiting list."
      actions={
        <>
          {can('booking.create') && <LinkButton href={`/bookings/new${view === 'day' ? `?date=${date}` : ''}`}>New booking</LinkButton>}
          <LinkButton href="/bookings/waiting-list" variant="secondary">Waiting list</LinkButton>
          <LinkButton href="/bookings/recurring" variant="secondary">Recurring</LinkButton>
        </>
      }
    />
  );

  const nav = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        {view !== 'list' && (
          <>
            <Link href={link({ date: prev === today ? undefined : prev })} aria-label="Previous" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line bg-surface text-lg md:min-h-10 md:min-w-10">‹</Link>
            <Link href={link({ date: undefined })} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium md:min-h-10">Today</Link>
            <Link href={link({ date: next })} aria-label="Next" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line bg-surface text-lg md:min-h-10 md:min-w-10">›</Link>
          </>
        )}
        <h2 className="ml-2 text-base font-semibold">{heading}</h2>
      </div>
      <Chips items={(['day', 'week', 'month', 'list'] as const).map((v) => ({ label: v === 'list' ? 'List' : v.charAt(0).toUpperCase() + v.slice(1), href: link({ view: v }), active: view === v }))} />
    </div>
  );

  if (view === 'list') {
    const { items, meta } = await listBookings(ctx, { ...filters, page: sp.page, pageSize: 25, dir: 'desc' });
    return (
      <>
        {header}{nav}{filterForm}
        {items.length === 0 ? (
          <EmptyState title="No bookings" action={can('booking.create') ? <LinkButton href="/bookings/new">Create a booking</LinkButton> : undefined}>No bookings match. Adjust the filters or create one.</EmptyState>
        ) : (
          <>
            <BookingList items={items as never} fmt={{ tz, locale: ctx.business.locale }} />
            <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => link({ page: String(p) })} />
          </>
        )}
      </>
    );
  }

  const cal = await getCalendar(ctx, { view, date, ...filters });
  const items = cal.items.map((b): CalBooking => {
    const s = localParts(b.startsAt, tz);
    const e = localParts(new Date(b.endsAt.getTime() - 1), tz);
    const startMin = s.minute;
    const sameDay = s.year === e.year && s.month === e.month && s.day === e.day;
    return {
      id: b.id, bookingNumber: b.bookingNumber, day: `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`,
      startMin, endMin: sameDay ? e.minute + 1 : 24 * 60, status: b.status, customer: b.customer.name,
      vehicle: [b.vehicle.registration, b.vehicle.model].filter(Boolean).join(' '), service: b.serviceLabel, technician: b.technicianName, bay: b.bayName,
      timeLabel: minutesToHhmm(startMin), canMove: ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'RESCHEDULED'].includes(b.status),
    };
  });
  const canReschedule = can('booking.reschedule') && ctx.subscription.canWrite;

  if (view === 'month') {
    const month = parseIsoDate(date)!.month;
    const days = Array.from({ length: cal.days }, (_, i) => addDays(cal.firstDay, i));
    const by = new Map<string, CalBooking[]>();
    for (const b of items) by.set(b.day, [...(by.get(b.day) ?? []), b]);
    return (
      <>
        {header}{nav}{filterForm}
        {cal.truncated && <p className="mb-2 text-sm text-warn">This month has more bookings than can be shown here; use the filters or the list view.</p>}
        <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-line bg-surface text-xs">
          {DOW.slice(1).concat(DOW[0]!).map((d) => <div key={d} className="border-b border-line bg-canvas px-1 py-1.5 text-center font-semibold uppercase tracking-wide text-muted">{d}</div>)}
          {days.map((d) => {
            const list = by.get(d) ?? [];
            const p = parseIsoDate(d)!;
            const closed = hasHours && !openDays.has(weekdayOf(d));
            return (
              <div key={d} className={`min-h-20 border-b border-r border-line p-1 sm:min-h-28 ${p.month !== month ? 'bg-canvas/70 text-muted' : closed ? 'bg-canvas/40' : ''}`}>
                <Link href={`/bookings?view=day&date=${d}`} className={`inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold ${d === today ? 'bg-brand-600 text-white' : 'hover:bg-canvas'}`}>{p.day}</Link>
                <ul className="mt-0.5 hidden space-y-0.5 sm:block">
                  {list.slice(0, 3).map((b) => <li key={b.id}><Link href={`/bookings/${b.id}`} className="block truncate rounded bg-brand-50 px-1 py-0.5 text-[11px] text-brand-700 hover:bg-brand-100">{b.timeLabel} {b.vehicle || b.customer}</Link></li>)}
                  {list.length > 3 && <li><Link href={`/bookings?view=day&date=${d}`} className="px-1 text-[11px] font-medium text-brand-700 hover:underline">+{list.length - 3} more</Link></li>}
                </ul>
                {list.length > 0 && <Link href={`/bookings?view=day&date=${d}`} className="mt-1 inline-block rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white sm:hidden">{list.length}</Link>}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  const gridDays: CalDay[] = Array.from({ length: cal.days }, (_, i) => {
    const iso = addDays(cal.firstDay, i);
    return { iso, label: dayLabel(iso), closed: hasHours && !openDays.has(weekdayOf(iso)) };
  });
  return (
    <>
      {header}{nav}{filterForm}
      {cal.truncated && <p className="mb-2 text-sm text-warn">More bookings than can be shown at once; narrow with the filters.</p>}
      {items.length === 0 && view === 'day' ? (
        <EmptyState title="No bookings this day" action={can('booking.create') ? <LinkButton href={`/bookings/new?date=${date}`}>Create a booking</LinkButton> : undefined}>Nothing is booked for {dayLabel(date)}.</EmptyState>
      ) : (
        <TimeGrid days={gridDays} bookings={items} canReschedule={canReschedule} />
      )}
    </>
  );
}
