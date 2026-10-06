import { Prisma } from '@/server/db/client';
import { requireFeature } from '@/server/billing/features';
import { addDays, weekdayOf } from '@/lib/tz';
import { JOB_STATUS_LABEL, type JobStatus } from '@/server/jobcards/transitions';
import { bar, col, fillPeriods, isoDay, localDate, n, nn, pageOf, pct, periodLabel, UNIT_GROUPS, unitSql, type Unit } from './util';
import type { ReportDef, RunEnv } from '../types';

const techOnJob = (env: RunEnv, alias = 'jc') =>
  env.params.technicianId
    ? Prisma.sql`AND (${Prisma.raw(alias)}.primary_technician_membership_id = ${env.params.technicianId}::uuid OR EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = ${Prisma.raw(alias)}.id AND jt.business_id = ${Prisma.raw(alias)}.business_id AND jt.membership_id = ${env.params.technicianId}::uuid))`
    : Prisma.empty;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ───────────────────────── jobs ─────────────────────────

export const jobs: ReportDef = {
  key: 'jobs', title: 'Jobs', category: 'jobs', dated: true, paged: true,
  description: 'Jobs opened in the period by status, technician, service, location or date, with completion and value.',
  permissions: ['job.view'], filters: ['range', 'location', 'customer', 'technician', 'serviceType', 'jobStatus', 'vehicle'],
  groupBys: [{ key: 'status', label: 'By status' }, { key: 'technician', label: 'By technician' }, { key: 'service', label: 'By service type' }, { key: 'location', label: 'By location' }, ...UNIT_GROUPS, { key: 'none', label: 'Each job' }],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const group = params.groupBy ?? 'status';
    const unit: Unit | null = group === 'day' || group === 'week' || group === 'month' ? group : null;
    const showValue = env.can('job.view_pricing') || env.can('finance.view_reports');
    const opened = localDate('jc.opened_at', tz);
    const where = Prisma.sql`
      jc.business_id = ${bid}::uuid AND ${opened} BETWEEN ${range.from}::date AND ${range.to}::date ${env.loc('jc')}
      ${env.eq('jc.customer_id', params.customerId, 'uuid')} ${env.eq('jc.vehicle_id', params.vehicleId, 'uuid')} ${env.eq('jc.service_type_id', params.serviceTypeId, 'uuid')}
      ${params.jobStatus ? Prisma.sql`AND jc.status = ${params.jobStatus}::job_card_status` : Prisma.empty} ${techOnJob(env)}`;
    const value = Prisma.sql`(SELECT COALESCE(SUM(i.taxable_cents),0) FROM invoices i WHERE i.job_id = jc.id AND i.business_id = jc.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL)`;
    const hasInv = Prisma.sql`EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = jc.id AND i.business_id = jc.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL)`;

    const totals = await tx.$queryRaw<{ n: number; completed: number; cancelled: number; on_hold: number; open: number; value: bigint; invoiced: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE jc.status = 'COMPLETED')::int AS completed, COUNT(*) FILTER (WHERE jc.status = 'CANCELLED')::int AS cancelled,
             COUNT(*) FILTER (WHERE jc.status = 'ON_HOLD')::int AS on_hold, COUNT(*) FILTER (WHERE jc.status NOT IN ('COMPLETED','CANCELLED','ON_HOLD','BOOKED'))::int AS open,
             COALESCE(SUM(${value}),0)::bigint AS value, COUNT(*) FILTER (WHERE ${hasInv})::int AS invoiced
        FROM job_cards jc WHERE ${where}`);
    const t = totals[0]!;
    const finished = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM job_cards jc WHERE jc.business_id = ${bid}::uuid AND jc.status = 'COMPLETED' AND jc.completed_at >= ${range.start} AND jc.completed_at < ${range.end}
        ${env.loc('jc')} ${env.eq('jc.customer_id', params.customerId, 'uuid')} ${env.eq('jc.service_type_id', params.serviceTypeId, 'uuid')} ${techOnJob(env)}`);
    const summary = [
      { key: 'total', label: 'Jobs opened', value: t.n, type: 'int' as const },
      { key: 'completed', label: 'Completed', value: t.completed, type: 'int' as const, hint: 'Of the jobs opened in the period' },
      { key: 'finished', label: 'Finished in the period', value: finished[0]?.n ?? 0, type: 'int' as const, hint: 'By completion date' },
      { key: 'open', label: 'In progress', value: t.open, type: 'int' as const },
      { key: 'onHold', label: 'On hold', value: t.on_hold, type: 'int' as const },
      { key: 'cancelled', label: 'Cancelled', value: t.cancelled, type: 'int' as const },
      ...(showValue ? [{ key: 'average', label: 'Average job value (ex VAT)', value: t.invoiced ? Math.round(n(t.value) / t.invoiced) : null, type: 'money' as const, hint: `Of ${t.invoiced} invoiced job${t.invoiced === 1 ? '' : 's'}` }] : []),
    ];
    const notes = ['Jobs are counted by the day they were opened; statuses are as they are now.', 'Average value uses invoiced jobs only (issued invoices, VAT excluded).', 'By technician uses the technician in charge of the job; a filter also matches helpers.'];

    if (group === 'none') {
      const { limit, offset } = pageOf(env);
      const rows = await tx.$queryRaw<{ id: string; job_number: string; opened: Date; customer_id: string; customer: string; vehicle_id: string; registration: string | null; service: string | null; technician: string | null; status: string; value: bigint }[]>(Prisma.sql`
        SELECT jc.id, jc.job_number, ${opened} AS opened, c.id AS customer_id, c.name AS customer, v.id AS vehicle_id, v.registration, jc.service_label AS service, u.name AS technician, jc.status::text AS status, ${value}::bigint AS value
          FROM job_cards jc JOIN customers c ON c.id = jc.customer_id AND c.business_id = jc.business_id JOIN vehicles v ON v.id = jc.vehicle_id AND v.business_id = jc.business_id
          LEFT JOIN memberships m ON m.id = jc.primary_technician_membership_id LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where} ORDER BY jc.opened_at DESC LIMIT ${limit} OFFSET ${offset}`);
      return {
        columns: [
          col('jobNumber', 'Job', 'text', { link: { path: '/jobs', idKey: 'id' } }), col('opened', 'Opened', 'date'), col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }),
          col('registration', 'Vehicle', 'text', { link: { path: '/vehicles', idKey: 'vehicleId' } }), col('service', 'Service', 'text'), col('technician', 'Technician', 'text'), col('status', 'Status', 'status'),
          ...(showValue ? [col('value', 'Invoiced (ex VAT)', 'money' as const)] : []),
        ],
        rows: rows.map((r) => ({ id: r.id, jobNumber: r.job_number, opened: isoDay(r.opened), customerId: r.customer_id, customer: r.customer, vehicleId: r.vehicle_id, registration: r.registration, service: r.service, technician: r.technician, status: JOB_STATUS_LABEL[r.status as JobStatus] ?? r.status, value: n(r.value) })),
        total: t.n, summary, notes,
      };
    }

    const key = group === 'technician' ? Prisma.sql`COALESCE(u.name, 'Unassigned')`
      : group === 'service' ? Prisma.sql`COALESCE(jc.service_label, '(no service)')`
      : group === 'location' ? Prisma.sql`COALESCE(l.name, 'No location')`
      : unit ? Prisma.sql`date_trunc(${unitSql(unit)}, ${opened})::date::text`
      : Prisma.sql`jc.status::text`;
    if (group === 'location') requireFeature(env.ctx.subscription, 'multi_location');
    const rows = await tx.$queryRaw<{ k: string; n: number; completed: number; cancelled: number; on_hold: number; open: number; value: bigint; invoiced: number }[]>(Prisma.sql`
      SELECT ${key} AS k, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE jc.status = 'COMPLETED')::int AS completed, COUNT(*) FILTER (WHERE jc.status = 'CANCELLED')::int AS cancelled,
             COUNT(*) FILTER (WHERE jc.status = 'ON_HOLD')::int AS on_hold, COUNT(*) FILTER (WHERE jc.status NOT IN ('COMPLETED','CANCELLED','ON_HOLD','BOOKED'))::int AS open,
             COALESCE(SUM(${value}),0)::bigint AS value, COUNT(*) FILTER (WHERE ${hasInv})::int AS invoiced
        FROM job_cards jc LEFT JOIN memberships m ON m.id = jc.primary_technician_membership_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN locations l ON l.id = jc.location_id
       WHERE ${where} GROUP BY 1 ORDER BY ${unit ? Prisma.sql`1` : Prisma.sql`COUNT(*) DESC, 1`} LIMIT 500`);
    type Row = { period: string; n: number; completed: number; cancelled: number; on_hold: number; open: number; value: number; invoiced: number };
    let data: (Row & { label: string })[] = rows.map((r) => ({ period: r.k, label: group === 'status' ? (JOB_STATUS_LABEL[r.k as JobStatus] ?? r.k) : r.k, n: r.n, completed: r.completed, cancelled: r.cancelled, on_hold: r.on_hold, open: r.open, value: n(r.value), invoiced: r.invoiced }));
    if (unit) data = fillPeriods(env, unit, data, (p) => ({ period: p, label: p, n: 0, completed: 0, cancelled: 0, on_hold: 0, open: 0, value: 0, invoiced: 0 })).map((r) => ({ ...r, label: periodLabel(r.period, unit) }));
    return {
      columns: [
        col('group', group === 'status' ? 'Status' : group === 'technician' ? 'Technician' : group === 'service' ? 'Service' : group === 'location' ? 'Location' : unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month', 'text'),
        col('jobs', 'Jobs', 'int'), col('completed', 'Completed', 'int'), col('open', 'In progress', 'int'), col('onHold', 'On hold', 'int'), col('cancelled', 'Cancelled', 'int'),
        ...(showValue ? [col('invoiced', 'Invoiced (ex VAT)', 'money' as const), col('average', 'Average job value', 'money' as const)] : []),
      ],
      rows: data.map((r) => ({ group: r.label, jobs: r.n, completed: r.completed, open: r.open, onHold: r.on_hold, cancelled: r.cancelled, invoiced: r.value, average: r.invoiced ? Math.round(r.value / r.invoiced) : null })),
      total: data.length, summary,
      charts: [bar(unit ? 'Jobs opened over time' : `Jobs ${group === 'status' ? 'by status' : group === 'technician' ? 'by technician' : group === 'service' ? 'by service' : 'by location'}`, 'int', data.map((r) => r.label), [{ name: 'Jobs', values: data.map((r) => r.n) }, { name: 'Completed', values: data.map((r) => r.completed) }], unit ? 'line' : 'bar')],
      notes,
    };
  },
};

// ───────────────────────── bookings ─────────────────────────

export const bookings: ReportDef = {
  key: 'bookings', title: 'Bookings', category: 'bookings', dated: true, paged: true,
  description: 'Booking volume and outcomes, no-shows, conversion to jobs, popular services, and the busiest days and hours.',
  permissions: ['booking.view'], filters: ['range', 'location', 'customer', 'technician', 'serviceType', 'bookingStatus'],
  groupBys: [{ key: 'status', label: 'By status' }, { key: 'service', label: 'Popular services' }, { key: 'weekday', label: 'Peak days' }, { key: 'hour', label: 'Peak times' }, { key: 'technician', label: 'By technician' }, ...UNIT_GROUPS, { key: 'none', label: 'Each booking' }],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const group = params.groupBy ?? 'status';
    const unit: Unit | null = group === 'day' || group === 'week' || group === 'month' ? group : null;
    const starts = localDate('b.starts_at', tz);
    const where = Prisma.sql`
      b.business_id = ${bid}::uuid AND ${starts} BETWEEN ${range.from}::date AND ${range.to}::date ${env.loc('b')}
      ${env.eq('b.customer_id', params.customerId, 'uuid')} ${env.eq('b.technician_membership_id', params.technicianId, 'uuid')} ${env.eq('b.service_type_id', params.serviceTypeId, 'uuid')}
      ${params.bookingStatus ? Prisma.sql`AND b.status = ${params.bookingStatus}::booking_status` : Prisma.empty}`;
    const t = (await tx.$queryRaw<{ n: number; confirmed: number; completed: number; cancelled: number; no_show: number; checked_in: number; started: number; converted: number; rescheduled: number; avg_min: number | null; booked_min: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE b.status IN ('CONFIRMED','REMINDER_SENT'))::int AS confirmed, COUNT(*) FILTER (WHERE b.status = 'COMPLETED')::int AS completed,
             COUNT(*) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled, COUNT(*) FILTER (WHERE b.status = 'NO_SHOW')::int AS no_show, COUNT(*) FILTER (WHERE b.status = 'CHECKED_IN')::int AS checked_in,
             COUNT(*) FILTER (WHERE b.starts_at < now() AND b.status <> 'CANCELLED')::int AS started,
             COUNT(*) FILTER (WHERE b.starts_at < now() AND b.status <> 'CANCELLED' AND EXISTS (SELECT 1 FROM job_cards j WHERE j.booking_id = b.id AND j.business_id = b.business_id))::int AS converted,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.business_id = b.business_id AND e.type = 'rescheduled'))::int AS rescheduled,
             AVG(b.duration_min) FILTER (WHERE b.status NOT IN ('CANCELLED','NO_SHOW')) AS avg_min,
             COALESCE(SUM(b.duration_min) FILTER (WHERE b.status NOT IN ('CANCELLED','NO_SHOW')),0)::bigint AS booked_min
        FROM bookings b WHERE ${where}`))[0]!;

    // Workshop capacity: only when bays AND opening hours exist, otherwise there is nothing honest to divide by.
    const bays = await tx.bay.count({ where: { businessId: bid, status: 'ACTIVE', ...(params.locationIds.length ? { OR: [{ locationId: { in: params.locationIds } }, { locationId: null }] } : {}) } });
    const hours = await tx.workshopHours.findMany({ where: { businessId: bid }, select: { weekday: true, startMinute: true, endMinute: true } });
    let openMinutes = 0;
    if (bays > 0 && hours.length) {
      const perWeekday = new Map<number, number>();
      for (const h of hours) perWeekday.set(h.weekday, (perWeekday.get(h.weekday) ?? 0) + (h.endMinute - h.startMinute));
      for (let d = range.from; d <= range.to; d = addDays(d, 1)) openMinutes += perWeekday.get(weekdayOf(d)) ?? 0;
    }
    const capacity = bays * openMinutes;
    const summary = [
      { key: 'total', label: 'Bookings', value: t.n, type: 'int' as const },
      { key: 'confirmed', label: 'Confirmed', value: t.confirmed, type: 'int' as const },
      { key: 'checkedIn', label: 'Checked in', value: t.checked_in, type: 'int' as const },
      { key: 'completed', label: 'Completed', value: t.completed, type: 'int' as const },
      { key: 'cancelled', label: 'Cancelled', value: t.cancelled, type: 'int' as const },
      { key: 'rescheduled', label: 'Rescheduled', value: t.rescheduled, type: 'int' as const, hint: 'Moved at least once' },
      { key: 'noShow', label: 'No-shows', value: t.no_show, type: 'int' as const, tone: t.no_show > 0 ? ('warn' as const) : undefined },
      { key: 'conversion', label: 'Became a job', value: pct(t.converted, t.started), type: 'pct' as const, hint: 'Of bookings whose time has passed, excluding cancelled' },
      { key: 'avgDuration', label: 'Average booking length (minutes)', value: t.avg_min === null ? null : Math.round(Number(t.avg_min)), type: 'int' as const },
      { key: 'utilisation', label: 'Workshop capacity used', value: capacity > 0 ? pct(n(t.booked_min), capacity) : null, type: 'pct' as const, hint: capacity > 0 ? `${Math.round(n(t.booked_min) / 60)} h booked of ${Math.round(capacity / 60)} bay-hours open` : 'Needs bays and opening hours to be set up' },
    ];
    const notes = ['Bookings are counted by their appointment day, in your time zone.', 'Capacity is booked minutes against bays multiplied by opening hours. With no bays or no opening hours set up it is left blank rather than guessed.'];

    if (group === 'none') {
      const { limit, offset } = pageOf(env);
      const rows = await tx.$queryRaw<{ id: string; booking_number: string; starts: Date; customer_id: string; customer: string; service: string; technician: string | null; status: string; duration: number }[]>(Prisma.sql`
        SELECT b.id, b.booking_number, b.starts_at AS starts, c.id AS customer_id, c.name AS customer, b.service_label AS service, u.name AS technician, b.status::text AS status, b.duration_min AS duration
          FROM bookings b JOIN customers c ON c.id = b.customer_id AND c.business_id = b.business_id LEFT JOIN memberships m ON m.id = b.technician_membership_id LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where} ORDER BY b.starts_at DESC LIMIT ${limit} OFFSET ${offset}`);
      return {
        columns: [col('bookingNumber', 'Booking', 'text', { link: { path: '/bookings', idKey: 'id' } }), col('starts', 'Appointment', 'datetime'), col('customer', 'Customer', 'text', { link: { path: '/customers', idKey: 'customerId' } }),
          col('service', 'Service', 'text'), col('technician', 'Technician', 'text'), col('duration', 'Minutes', 'int'), col('status', 'Status', 'status')],
        rows: rows.map((r) => ({ id: r.id, bookingNumber: r.booking_number, starts: r.starts.toISOString(), customerId: r.customer_id, customer: r.customer, service: r.service, technician: r.technician, duration: r.duration, status: r.status.replace(/_/g, ' ').toLowerCase() })),
        total: t.n, summary, notes,
      };
    }

    const key = group === 'service' ? Prisma.sql`b.service_label` : group === 'technician' ? Prisma.sql`COALESCE(u.name, 'Unassigned')`
      : group === 'weekday' ? Prisma.sql`EXTRACT(DOW FROM ${starts})::int::text` : group === 'hour' ? Prisma.sql`EXTRACT(HOUR FROM (b.starts_at AT TIME ZONE ${tz}))::int::text`
      : unit ? Prisma.sql`date_trunc(${unitSql(unit)}, ${starts})::date::text` : Prisma.sql`b.status::text`;
    const rows = await tx.$queryRaw<{ k: string; n: number; completed: number; cancelled: number; no_show: number; minutes: bigint }[]>(Prisma.sql`
      SELECT ${key} AS k, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE b.status = 'COMPLETED')::int AS completed, COUNT(*) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled,
             COUNT(*) FILTER (WHERE b.status = 'NO_SHOW')::int AS no_show, COALESCE(SUM(b.duration_min) FILTER (WHERE b.status NOT IN ('CANCELLED','NO_SHOW')),0)::bigint AS minutes
        FROM bookings b LEFT JOIN memberships m ON m.id = b.technician_membership_id LEFT JOIN users u ON u.id = m.user_id
       WHERE ${where} GROUP BY 1 LIMIT 500`);
    type R = { k: string; label: string; n: number; completed: number; cancelled: number; no_show: number; minutes: number };
    let data: R[] = rows.map((r) => ({ k: r.k, label: r.k, n: r.n, completed: r.completed, cancelled: r.cancelled, no_show: r.no_show, minutes: n(r.minutes) }));
    if (group === 'weekday') { const by = new Map(data.map((r) => [Number(r.k), r])); data = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ ...(by.get(d) ?? { k: String(d), n: 0, completed: 0, cancelled: 0, no_show: 0, minutes: 0 }), label: WEEKDAYS[d]! })); }
    else if (group === 'hour') { const by = new Map(data.map((r) => [Number(r.k), r])); data = Array.from({ length: 24 }, (_, h) => h).filter((h) => by.has(h) || (h >= 6 && h <= 18)).map((h) => ({ ...(by.get(h) ?? { k: String(h), n: 0, completed: 0, cancelled: 0, no_show: 0, minutes: 0 }), label: `${String(h).padStart(2, '0')}:00` })); }
    else if (unit) data = fillPeriods(env, unit, data.map((r) => ({ ...r, period: r.k })), (p) => ({ period: p, k: p, label: p, n: 0, completed: 0, cancelled: 0, no_show: 0, minutes: 0 })).map((r) => ({ ...r, label: periodLabel(r.period, unit) }));
    else if (group === 'status') data = data.map((r) => ({ ...r, label: r.k.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) })).sort((a, b) => b.n - a.n);
    else data.sort((a, b) => b.n - a.n);
    const title = { status: 'Bookings by status', service: 'Popular services', weekday: 'Bookings by day of the week', hour: 'Bookings by hour of the day', technician: 'Bookings by technician' }[group] ?? 'Bookings over time';
    return {
      columns: [col('group', { status: 'Status', service: 'Service', weekday: 'Day', hour: 'Hour', technician: 'Technician' }[group] ?? (unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month'), 'text'),
        col('bookings', 'Bookings', 'int'), col('completed', 'Completed', 'int'), col('cancelled', 'Cancelled', 'int'), col('noShow', 'No-shows', 'int'), col('hours', 'Booked hours', 'hours')],
      rows: data.map((r) => ({ group: r.label, bookings: r.n, completed: r.completed, cancelled: r.cancelled, noShow: r.no_show, hours: Math.round((r.minutes / 60) * 10) / 10 })),
      total: data.length, summary,
      charts: [bar(title, 'int', data.map((r) => r.label), [{ name: 'Bookings', values: data.map((r) => r.n) }], unit ? 'line' : 'bar')],
      notes,
    };
  },
};

export const OPS: ReportDef[] = [jobs, bookings];
void nn;
