import { Prisma } from '@/server/db/client';
import { dateOnly } from '@/server/finance/common';
import { bar, col, isoDay, localDate, n, nn, pageOf, pct } from './util';
import type { ReportDef } from '../types';

/**
 * Customer and vehicle reports. Nothing here infers anything about a person: every figure is a count, a date or a sum of
 * their own records. "Visit" means a job was opened for them.
 */

const spend = (alias: string) => Prisma.sql`(SELECT COALESCE(SUM(i.taxable_cents),0) FROM invoices i WHERE i.customer_id = ${Prisma.raw(alias)}.id AND i.business_id = ${Prisma.raw(alias)}.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL)`;
const owing = (alias: string) => Prisma.sql`(SELECT COALESCE(SUM(i.outstanding_cents),0) FROM invoices i WHERE i.customer_id = ${Prisma.raw(alias)}.id AND i.business_id = ${Prisma.raw(alias)}.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.written_off_at IS NULL)`;

export const customers: ReportDef = {
  key: 'customers', title: 'Customers', category: 'customers', dated: true, paged: true,
  description: 'Customer counts, new and returning customers, spend, jobs, last visit, vehicles and balances.',
  permissions: ['customer.view'], filters: ['range', 'location', 'customerStatus', 'search'],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const money = env.can('finance.view_reports') || env.can('invoice.view');
    const created = localDate('c.created_at', tz);
    const like = params.search ? `%${params.search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const search = like ? Prisma.sql`AND (c.name ILIKE ${like} OR c.customer_number ILIKE ${like} OR c.email ILIKE ${like} OR c.mobile ILIKE ${like})` : Prisma.empty;
    const status = params.customerStatus ? Prisma.sql`AND c.status = ${params.customerStatus}::customer_status` : Prisma.sql`AND c.status <> 'ARCHIVED'`;
    // A location filter means "customers who had a job at that location".
    const locationJoin = params.locationIds.length || env.scope ? Prisma.sql`AND EXISTS (SELECT 1 FROM job_cards jl WHERE jl.customer_id = c.id AND jl.business_id = c.business_id ${env.loc('jl')} ${params.locationIds.length ? Prisma.empty : Prisma.empty})` : Prisma.empty;
    const base = Prisma.sql`FROM customers c WHERE c.business_id = ${bid}::uuid ${status} ${search} ${params.locationIds.length ? locationJoin : Prisma.empty}`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; customer_number: string; name: string; status: string; created: Date; jobs: number; last_visit: Date | null; vehicles: number; spend: bigint; owing: bigint }[]>(Prisma.sql`
      SELECT c.id, c.customer_number, c.name, c.status::text AS status, ${created} AS created,
             (SELECT COUNT(*)::int FROM job_cards j WHERE j.customer_id = c.id AND j.business_id = c.business_id AND j.status <> 'CANCELLED') AS jobs,
             (SELECT MAX(${localDate('j.opened_at', tz)}) FROM job_cards j WHERE j.customer_id = c.id AND j.business_id = c.business_id AND j.status <> 'CANCELLED') AS last_visit,
             (SELECT COUNT(*)::int FROM vehicles v WHERE v.customer_id = c.id AND v.business_id = c.business_id AND v.archived_at IS NULL) AS vehicles,
             ${spend('c')}::bigint AS spend, ${owing('c')}::bigint AS owing
        ${base} ORDER BY c.name ASC LIMIT ${limit} OFFSET ${offset}`);
    const counts = await tx.$queryRaw<{ total: number; active: number; inactive: number; created_in: number; returning: number; with_jobs: number; spend: bigint; jobs: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE c.status = 'ACTIVE')::int AS active, COUNT(*) FILTER (WHERE c.status = 'INACTIVE')::int AS inactive,
             COUNT(*) FILTER (WHERE ${created} BETWEEN ${range.from}::date AND ${range.to}::date)::int AS created_in,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM job_cards j WHERE j.customer_id = c.id AND j.business_id = c.business_id AND j.status <> 'CANCELLED' AND j.opened_at >= ${range.start} AND j.opened_at < ${range.end})
                               AND EXISTS (SELECT 1 FROM job_cards j2 WHERE j2.customer_id = c.id AND j2.business_id = c.business_id AND j2.status <> 'CANCELLED' AND j2.opened_at < ${range.start}))::int AS returning,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM job_cards j WHERE j.customer_id = c.id AND j.business_id = c.business_id AND j.status <> 'CANCELLED'))::int AS with_jobs,
             COALESCE(SUM(${spend('c')}),0)::bigint AS spend,
             COALESCE(SUM((SELECT COUNT(*) FROM job_cards j WHERE j.customer_id = c.id AND j.business_id = c.business_id AND j.status <> 'CANCELLED')),0)::int AS jobs
        ${base}`);
    const t = counts[0]!;
    return {
      columns: [
        col('customerNumber', 'No.', 'text'), col('name', 'Customer', 'text', { link: { path: '/customers', idKey: 'id' } }), col('status', 'Status', 'status'), col('created', 'Customer since', 'date'),
        col('vehicles', 'Vehicles', 'int'), col('jobs', 'Jobs', 'int'), col('lastVisit', 'Last visit', 'date'),
        ...(money ? [col('spend', 'Spend (ex VAT)', 'money' as const, { needs: 'invoice.view' as const }), col('owing', 'Owes now', 'money' as const, { needs: 'invoice.view' as const })] : []),
      ],
      rows: rows.map((r) => ({ id: r.id, customerNumber: r.customer_number, name: r.name, status: r.status.toLowerCase(), created: isoDay(r.created), vehicles: r.vehicles, jobs: r.jobs, lastVisit: isoDay(r.last_visit), spend: n(r.spend), owing: n(r.owing) })),
      total: t.total,
      summary: [
        { key: 'total', label: 'Customers', value: t.total, type: 'int' },
        { key: 'active', label: 'Active', value: t.active, type: 'int' },
        { key: 'inactive', label: 'Inactive', value: t.inactive, type: 'int' },
        { key: 'new', label: 'New in the period', value: t.created_in, type: 'int', hint: 'Added to your customer list' },
        { key: 'returning', label: 'Returning in the period', value: t.returning, type: 'int', hint: 'Had a job in the period and an earlier one before it' },
        { key: 'jobsPer', label: 'Jobs per customer', value: t.with_jobs ? Math.round((t.jobs / t.with_jobs) * 10) / 10 : null, type: 'int', hint: 'Customers with at least one job' },
        { key: 'avgValue', label: 'Average customer value (ex VAT)', value: t.with_jobs ? Math.round(n(t.spend) / t.with_jobs) : null, type: 'money', needs: 'invoice.view', hint: 'Invoiced, all time' },
      ],
      charts: [bar('Customers by status', 'int', ['Active', 'Inactive'], [{ name: 'Customers', values: [t.active, t.inactive] }])],
      notes: ['Archived customers are not counted. A customer visit is a job being opened for them.', 'With a location chosen, only customers who had a job at that location are listed; customers are not tied to a location themselves.'],
    };
  },
};

// ───────────────────────── retention ─────────────────────────

export const retention: ReportDef = {
  key: 'retention', title: 'Customer retention', category: 'customers', dated: true, paged: true, feature: 'advanced_reports',
  description: 'Returning customers, new versus returning jobs, customers who have not visited for a while, and the time between visits.',
  permissions: ['customer.view', 'job.view'], filters: ['range', 'location'],
  groupBys: [{ key: 'lapsed', label: 'Not visited recently' }, { key: 'repeat', label: 'Repeat customers' }],
  async run(env) {
    const { tx, ctx, range, params, config } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const lapsedDays = config.lapsedCustomerDays;
    const loc = env.loc('j');
    const group = params.groupBy ?? 'lapsed';

    const jobs = await tx.$queryRaw<{ new_jobs: number; returning_jobs: number; customers: number; returning_customers: number }[]>(Prisma.sql`
      WITH firsts AS (SELECT customer_id, MIN(opened_at) AS first_at FROM job_cards WHERE business_id = ${bid}::uuid AND status <> 'CANCELLED' GROUP BY customer_id)
      SELECT COUNT(*) FILTER (WHERE f.first_at >= ${range.start} AND f.first_at < ${range.end} AND j.opened_at = f.first_at)::int AS new_jobs,
             COUNT(*) FILTER (WHERE NOT (j.opened_at = f.first_at))::int AS returning_jobs,
             COUNT(DISTINCT j.customer_id)::int AS customers,
             COUNT(DISTINCT j.customer_id) FILTER (WHERE f.first_at < ${range.start})::int AS returning_customers
        FROM job_cards j JOIN firsts f ON f.customer_id = j.customer_id
       WHERE j.business_id = ${bid}::uuid AND j.status <> 'CANCELLED' AND j.opened_at >= ${range.start} AND j.opened_at < ${range.end} ${loc}`);
    const gaps = await tx.$queryRaw<{ avg_days: number | null; visits: number }[]>(Prisma.sql`
      SELECT AVG(g.gap)::float8 AS avg_days, COUNT(*)::int AS visits FROM (
        SELECT (${localDate('j.opened_at', tz)} - LAG(${localDate('j.opened_at', tz)}) OVER (PARTITION BY j.customer_id ORDER BY j.opened_at)) AS gap
          FROM job_cards j WHERE j.business_id = ${bid}::uuid AND j.status <> 'CANCELLED' ${loc}) g WHERE g.gap IS NOT NULL`);
    const lapsed = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM (SELECT j.customer_id, MAX(j.opened_at) AS last_at FROM job_cards j JOIN customers c ON c.id = j.customer_id AND c.business_id = j.business_id
        WHERE j.business_id = ${bid}::uuid AND j.status <> 'CANCELLED' AND c.status = 'ACTIVE' ${loc} GROUP BY j.customer_id) s WHERE s.last_at < now() - make_interval(days => ${lapsedDays})`);
    const repeat = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM (SELECT j.customer_id FROM job_cards j WHERE j.business_id = ${bid}::uuid AND j.status = 'COMPLETED' ${loc} GROUP BY j.customer_id HAVING COUNT(*) >= 2) s`);
    const t = jobs[0]!;
    const { limit, offset } = pageOf(env);
    const listSql = group === 'repeat'
      ? Prisma.sql`SELECT c.id, c.name, c.customer_number, COUNT(*)::int AS visits, MAX(${localDate('j.opened_at', tz)}) AS last_visit, MIN(${localDate('j.opened_at', tz)}) AS first_visit
          FROM job_cards j JOIN customers c ON c.id = j.customer_id AND c.business_id = j.business_id WHERE j.business_id = ${bid}::uuid AND j.status = 'COMPLETED' ${loc}
          GROUP BY c.id HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, c.name LIMIT ${limit} OFFSET ${offset}`
      : Prisma.sql`SELECT c.id, c.name, c.customer_number, COUNT(*)::int AS visits, MAX(${localDate('j.opened_at', tz)}) AS last_visit, MIN(${localDate('j.opened_at', tz)}) AS first_visit
          FROM job_cards j JOIN customers c ON c.id = j.customer_id AND c.business_id = j.business_id WHERE j.business_id = ${bid}::uuid AND j.status <> 'CANCELLED' AND c.status = 'ACTIVE' ${loc}
          GROUP BY c.id HAVING MAX(j.opened_at) < now() - make_interval(days => ${lapsedDays}) ORDER BY MAX(j.opened_at) ASC LIMIT ${limit} OFFSET ${offset}`;
    const rows = await tx.$queryRaw<{ id: string; name: string; customer_number: string; visits: number; last_visit: Date; first_visit: Date }[]>(listSql);
    const totalRows = group === 'repeat' ? (repeat[0]?.n ?? 0) : (lapsed[0]?.n ?? 0);
    return {
      columns: [col('customerNumber', 'No.', 'text'), col('name', 'Customer', 'text', { link: { path: '/customers', idKey: 'id' } }), col('visits', group === 'repeat' ? 'Completed jobs' : 'Visits', 'int'), col('firstVisit', 'First visit', 'date'), col('lastVisit', 'Last visit', 'date')],
      rows: rows.map((r) => ({ id: r.id, name: r.name, customerNumber: r.customer_number, visits: r.visits, firstVisit: isoDay(r.first_visit), lastVisit: isoDay(r.last_visit) })),
      total: totalRows,
      summary: [
        { key: 'customers', label: 'Customers with a job in the period', value: t.customers, type: 'int' },
        { key: 'returningCustomers', label: 'Returning customers', value: t.returning_customers, type: 'int', hint: 'Also had a job before the period' },
        { key: 'newJobs', label: 'Jobs from first-time customers', value: t.new_jobs, type: 'int' },
        { key: 'returningJobs', label: 'Jobs from returning customers', value: t.returning_jobs, type: 'int' },
        { key: 'lapsed', label: `No visit in ${lapsedDays} days`, value: lapsed[0]?.n ?? 0, type: 'int', hint: 'Active customers; the period is a setting', tone: (lapsed[0]?.n ?? 0) > 0 ? 'warn' : undefined },
        { key: 'avgGap', label: 'Average days between visits', value: gaps[0]?.avg_days === null || gaps[0] === undefined ? null : Math.round(Number(gaps[0].avg_days)), type: 'int', hint: gaps[0]?.visits ? `From ${gaps[0].visits} repeat visits` : 'Needs customers with two or more visits' },
        { key: 'repeat', label: 'Repeat customers', value: repeat[0]?.n ?? 0, type: 'int', hint: 'Two or more completed jobs, all time' },
      ],
      charts: [bar('New and returning jobs', 'int', ['First-time customers', 'Returning customers'], [{ name: 'Jobs', values: [t.new_jobs, t.returning_jobs] }])],
      notes: ['A visit is a job being opened. The "not visited" period is a reporting setting (Settings, Reports).', 'Averages are only shown where customers have two or more visits; there is no prediction.'],
    };
  },
};

// ───────────────────────── vehicles ─────────────────────────

export const vehicles: ReportDef = {
  key: 'vehicles', title: 'Vehicles', category: 'vehicles', dated: true, paged: true,
  description: 'Vehicles serviced, jobs and spend per vehicle, last and upcoming service, and what is in the workshop now.',
  permissions: ['vehicle.view'], filters: ['range', 'location', 'make', 'model', 'year', 'vehicleStatus', 'search'],
  groupBys: [{ key: 'all', label: 'All vehicles' }, { key: 'inWorkshop', label: 'In the workshop now' }, { key: 'awaitingParts', label: 'Awaiting parts' }, { key: 'attention', label: 'Needing attention' }],
  async run(env) {
    const { tx, ctx, range, params, today } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const money = env.can('invoice.view') || env.can('finance.view_reports');
    const like = params.search ? `%${params.search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const group = params.groupBy ?? 'all';
    const openJob = Prisma.sql`EXISTS (SELECT 1 FROM job_cards j WHERE j.vehicle_id = v.id AND j.business_id = v.business_id AND j.status NOT IN ('COMPLETED','CANCELLED'))`;
    const parts = Prisma.sql`EXISTS (SELECT 1 FROM job_cards j WHERE j.vehicle_id = v.id AND j.business_id = v.business_id AND j.status = 'AWAITING_PARTS')`;
    // A vehicle needs attention when an active service interval is past due by date or by its last known mileage.
    const attention = Prisma.sql`EXISTS (SELECT 1 FROM service_intervals si WHERE si.vehicle_id = v.id AND si.business_id = v.business_id AND si.active
        AND ((si.every_months IS NOT NULL AND si.last_service_at IS NOT NULL AND (si.last_service_at AT TIME ZONE ${tz})::date + (si.every_months * interval '1 month') < ${today}::date)
          OR (si.every_km IS NOT NULL AND si.last_service_km IS NOT NULL AND v.mileage_km IS NOT NULL AND v.mileage_km >= si.last_service_km + si.every_km)))`;
    const locVeh = params.locationIds.length ? Prisma.sql`AND EXISTS (SELECT 1 FROM job_cards jl WHERE jl.vehicle_id = v.id AND jl.business_id = v.business_id ${env.loc('jl')})` : Prisma.empty;
    const groupFilter = group === 'inWorkshop' ? Prisma.sql`AND ${openJob}` : group === 'awaitingParts' ? Prisma.sql`AND ${parts}` : group === 'attention' ? Prisma.sql`AND ${attention}` : Prisma.empty;
    const base = Prisma.sql`FROM vehicles v JOIN customers c ON c.id = v.customer_id AND c.business_id = v.business_id
      WHERE v.business_id = ${bid}::uuid AND v.archived_at IS NULL ${env.eq('v.make', params.make)} ${env.eq('v.model', params.model)} ${env.eq('v.year', params.year)}
        ${params.vehicleStatus ? Prisma.sql`AND v.status = ${params.vehicleStatus}::vehicle_status` : Prisma.empty}
        ${like ? Prisma.sql`AND (v.registration ILIKE ${like} OR v.vin ILIKE ${like} OR c.name ILIKE ${like})` : Prisma.empty} ${locVeh} ${groupFilter}`;
    const { limit, offset } = pageOf(env);
    const rows = await tx.$queryRaw<{ id: string; registration: string | null; vehicle: string; customer_id: string; customer: string; status: string; mileage: number | null; jobs: number; last_service: Date | null; next_due: Date | null; spend: bigint; in_workshop: boolean; awaiting_parts: boolean; attention: boolean }[]>(Prisma.sql`
      SELECT v.id, v.registration, concat_ws(' ', v.year::text, v.make, v.model) AS vehicle, c.id AS customer_id, c.name AS customer, v.status::text AS status, v.mileage_km AS mileage,
             (SELECT COUNT(*)::int FROM job_cards j WHERE j.vehicle_id = v.id AND j.business_id = v.business_id AND j.status <> 'CANCELLED' AND ${localDate('j.opened_at', tz)} BETWEEN ${range.from}::date AND ${range.to}::date) AS jobs,
             (SELECT MAX(${localDate('j.completed_at', tz)}) FROM job_cards j WHERE j.vehicle_id = v.id AND j.business_id = v.business_id AND j.status = 'COMPLETED') AS last_service,
             (SELECT MIN((si.last_service_at AT TIME ZONE ${tz})::date + (si.every_months * interval '1 month')) FROM service_intervals si WHERE si.vehicle_id = v.id AND si.business_id = v.business_id AND si.active AND si.every_months IS NOT NULL AND si.last_service_at IS NOT NULL) AS next_due,
             (SELECT COALESCE(SUM(i.taxable_cents),0) FROM invoices i WHERE i.vehicle_id = v.id AND i.business_id = v.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)})::bigint AS spend,
             ${openJob} AS in_workshop, ${parts} AS awaiting_parts, ${attention} AS attention
        ${base} ORDER BY v.registration ASC NULLS LAST LIMIT ${limit} OFFSET ${offset}`);
    const t = (await tx.$queryRaw<{ total: number; serviced: number; in_workshop: number; awaiting: number; attention: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM job_cards j WHERE j.vehicle_id = v.id AND j.business_id = v.business_id AND j.status = 'COMPLETED' AND j.completed_at >= ${range.start} AND j.completed_at < ${range.end}))::int AS serviced,
             COUNT(*) FILTER (WHERE ${openJob})::int AS in_workshop, COUNT(*) FILTER (WHERE ${parts})::int AS awaiting, COUNT(*) FILTER (WHERE ${attention})::int AS attention ${base}`))[0]!;
    return {
      columns: [
        col('registration', 'Registration', 'text', { link: { path: '/vehicles', idKey: 'id' } }), col('vehicle', 'Vehicle', 'text'), col('customer', 'Owner', 'text', { link: { path: '/customers', idKey: 'customerId' } }),
        col('status', 'Status', 'status'), col('mileage', 'Mileage (km)', 'int'), col('jobs', 'Jobs in period', 'int'), col('lastService', 'Last service', 'date'), col('nextDue', 'Next service due', 'date'),
        ...(money ? [col('spend', 'Spend in period (ex VAT)', 'money' as const, { needs: 'invoice.view' as const })] : []),
        col('flags', 'Flags', 'text'),
      ],
      rows: rows.map((r) => ({
        id: r.id, registration: r.registration ?? '—', vehicle: r.vehicle, customerId: r.customer_id, customer: r.customer, status: r.status.replace(/_/g, ' ').toLowerCase(), mileage: r.mileage, jobs: r.jobs,
        lastService: isoDay(r.last_service), nextDue: isoDay(r.next_due), spend: n(r.spend),
        flags: [r.in_workshop ? 'In workshop' : null, r.awaiting_parts ? 'Awaiting parts' : null, r.attention ? 'Service overdue' : null].filter(Boolean).join(', '),
      })),
      total: t.total,
      summary: [
        { key: 'total', label: 'Vehicles', value: t.total, type: 'int' },
        { key: 'serviced', label: 'Serviced in the period', value: t.serviced, type: 'int', hint: 'A completed job in the period' },
        { key: 'inWorkshop', label: 'In the workshop now', value: t.in_workshop, type: 'int' },
        { key: 'awaiting', label: 'Awaiting parts', value: t.awaiting, type: 'int' },
        { key: 'attention', label: 'Service overdue', value: t.attention, type: 'int', tone: t.attention > 0 ? 'warn' : undefined, hint: 'By date or last recorded mileage' },
      ],
      charts: [bar('Vehicles now', 'int', ['In the workshop', 'Awaiting parts', 'Service overdue'], [{ name: 'Vehicles', values: [t.in_workshop, t.awaiting, t.attention] }])],
      notes: ['Next service due is the earliest due date among the vehicle\'s active service intervals that have a month interval and a recorded last service. Mileage is the last recorded odometer reading.', 'With a location chosen, only vehicles that had a job at that location are listed.'],
    };
  },
};

export const PEOPLE_CUSTOMERS: ReportDef[] = [customers, retention, vehicles];
void nn; void pct;
