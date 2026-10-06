import { Prisma } from '@/server/db/client';
import { dateOnly } from '@/server/finance/common';
import { metricsFor } from '@/server/team/performance';
import { listTechnicians } from '@/server/workshop/people';
import { bar, col, fillPeriods, localDate, n, periodLabel, UNIT_GROUPS, unitSql, type Unit } from './util';
import type { ReportDef } from '../types';

/**
 * Technician workload and labour. These are operational figures about work done and hours recorded; they make no judgement about a
 * person. Rates charged to customers are shown only to people who may see labour rates, and what time costs the business only to
 * people who may see labour costs (the framework removes those columns otherwise).
 */

export const technicians: ReportDef = {
  key: 'technicians', title: 'Technician workload', category: 'technicians', dated: true, feature: 'advanced_reports',
  description: 'Jobs, bookings, hours worked and billable, completion time and utilisation for each technician.',
  permissions: ['employee.view_reports'], filters: ['range'],
  async run(env) {
    const { tx, ctx, range } = env;
    const bid = ctx.business.id;
    const techs = await listTechnicians(tx, bid);
    const members = await tx.membership.findMany({ where: { businessId: bid, id: { in: techs.map((t) => t.membershipId) } }, select: { id: true, userId: true } });
    const uid = new Map(members.map((m) => [m.id, m.userId]));
    const assigned = await tx.$queryRaw<{ m: string; n: number }[]>(Prisma.sql`
      SELECT x.m, COUNT(DISTINCT x.job)::int AS n FROM (
        SELECT jc.primary_technician_membership_id AS m, jc.id AS job FROM job_cards jc WHERE jc.business_id = ${bid}::uuid AND jc.opened_at >= ${range.start} AND jc.opened_at < ${range.end} AND jc.primary_technician_membership_id IS NOT NULL
        UNION ALL SELECT jt.membership_id, jc.id FROM job_technicians jt JOIN job_cards jc ON jc.id = jt.job_id AND jc.business_id = jt.business_id WHERE jt.business_id = ${bid}::uuid AND jc.opened_at >= ${range.start} AND jc.opened_at < ${range.end}) x GROUP BY x.m`);
    const asg = new Map(assigned.map((a) => [a.m, a.n]));
    const rows: { name: string; assigned: number; completed: number; open: number; bookings: number; worked: number; billable: number; labourRevenue: number; avgCompletion: number | null; utilisation: number | null; capacity: number }[] = [];
    for (const t of techs) {
      const m = await metricsFor(tx, ctx, t.membershipId, t.name, uid.get(t.membershipId) ?? null, { from: range.from, to: range.to, start: range.start, end: range.end }, env.can('labour.view_rates'));
      rows.push({
        name: t.name, assigned: asg.get(t.membershipId) ?? 0, completed: m.jobsCompleted, open: m.jobsOpen, bookings: m.bookings, worked: Math.round((m.workedMinutes / 60) * 10) / 10,
        billable: Math.round((m.billableMinutes / 60) * 10) / 10, labourRevenue: m.labourRevenueCents ?? 0, avgCompletion: m.avgCompletionHours,
        utilisation: m.utilisationBps === null ? null : Math.round(m.utilisationBps / 10) / 10, capacity: Math.round((m.capacityMinutes / 60) * 10) / 10,
      });
    }
    const sum = (k: 'assigned' | 'completed' | 'open' | 'bookings' | 'worked' | 'billable' | 'labourRevenue') => rows.reduce((a, r) => a + r[k], 0);
    return {
      columns: [
        col('name', 'Technician', 'text'), col('assigned', 'Jobs assigned', 'int'), col('completed', 'Completed', 'int'), col('open', 'In progress now', 'int'), col('bookings', 'Bookings', 'int'),
        col('worked', 'Hours worked', 'hours'), col('billable', 'Billable hours', 'hours'), col('labourRevenue', 'Labour recorded (ex VAT)', 'money', { needs: 'labour.view_rates' }),
        col('avgCompletion', 'Average time to complete (hours)', 'hours'), col('utilisation', 'Utilisation', 'pct'),
      ],
      rows,
      summary: [
        { key: 'technicians', label: 'Technicians', value: rows.length, type: 'int' },
        { key: 'assigned', label: 'Jobs assigned', value: sum('assigned'), type: 'int' },
        { key: 'completed', label: 'Jobs completed', value: sum('completed'), type: 'int' },
        { key: 'worked', label: 'Hours worked', value: Math.round(sum('worked') * 10) / 10, type: 'hours' },
        { key: 'billable', label: 'Billable hours', value: Math.round(sum('billable') * 10) / 10, type: 'hours' },
        { key: 'labourRevenue', label: 'Labour recorded (ex VAT)', value: sum('labourRevenue'), type: 'money', needs: 'labour.view_rates' },
      ],
      charts: [bar('Hours by technician', 'hours', rows.map((r) => r.name), [{ name: 'Worked', values: rows.map((r) => r.worked) }, { name: 'Billable', values: rows.map((r) => r.billable) }])],
      notes: [
        'Hours come from completed time entries. Utilisation is hours worked against the hours the person was available (their own hours, or the workshop\'s, less time off); it is blank where no hours are set up.',
        'Average time to complete is from a job being opened to being completed, for jobs completed in the period. These are workload figures, not an assessment of anyone.',
      ],
    };
  },
};

// ───────────────────────── labour ─────────────────────────

export const labour: ReportDef = {
  key: 'labour', title: 'Labour', category: 'technicians', dated: true, feature: 'advanced_reports', sensitive: true,
  description: 'Hours worked and billed, labour revenue, labour cost and gross labour margin. Rates in force when the work was invoiced are kept.',
  permissions: ['employee.view_reports', 'labour.view_rates'], filters: ['range', 'location', 'technician', 'serviceType'],
  groupBys: [{ key: 'technician', label: 'By technician' }, { key: 'service', label: 'By service' }, ...UNIT_GROUPS],
  async run(env) {
    const { tx, ctx, range, params } = env;
    const bid = ctx.business.id;
    const tz = ctx.business.timezone;
    const group = params.groupBy ?? 'technician';
    const unit: Unit | null = group === 'day' || group === 'week' || group === 'month' ? group : null;
    const teKey = group === 'technician' ? Prisma.sql`COALESCE(u.name, 'Unknown')` : group === 'service' ? Prisma.sql`COALESCE(j.service_label, '(no service)')` : Prisma.sql`date_trunc(${unitSql(unit ?? 'day')}, ${localDate('te.started_at', tz)})::date::text`;
    const ilKey = group === 'technician' ? Prisma.sql`COALESCE(u.name, 'Unknown')` : group === 'service' ? Prisma.sql`COALESCE(j.service_label, '(no service)')` : Prisma.sql`date_trunc(${unitSql(unit ?? 'day')}, i.invoice_date)::date::text`;
    const techE = params.technicianId ? Prisma.sql`AND te.membership_id = ${params.technicianId}::uuid` : Prisma.empty;
    const techL = params.technicianId ? Prisma.sql`AND l.technician_membership_id = ${params.technicianId}::uuid` : Prisma.empty;
    const svcJ = params.serviceTypeId ? Prisma.sql`AND j.service_type_id = ${params.serviceTypeId}::uuid` : Prisma.empty;

    const time = await tx.$queryRaw<{ k: string; worked: bigint; billable: bigint }[]>(Prisma.sql`
      SELECT ${teKey} AS k, COALESCE(SUM(te.duration_minutes),0)::bigint AS worked, COALESCE(SUM(te.duration_minutes) FILTER (WHERE te.billable),0)::bigint AS billable
        FROM time_entries te JOIN job_cards j ON j.id = te.job_id AND j.business_id = te.business_id LEFT JOIN memberships m ON m.id = te.membership_id LEFT JOIN users u ON u.id = m.user_id
       WHERE te.business_id = ${bid}::uuid AND te.status = 'COMPLETED' AND te.started_at >= ${range.start} AND te.started_at < ${range.end} ${env.loc('j')} ${techE} ${svcJ} GROUP BY 1`);
    const lines = await tx.$queryRaw<{ k: string; minutes: bigint; revenue: bigint; cost: bigint; uncosted: number }[]>(Prisma.sql`
      SELECT ${ilKey} AS k, COALESCE(SUM(l.minutes),0)::bigint AS minutes, COALESCE(SUM(l.taxable_cents),0)::bigint AS revenue,
             COALESCE(SUM(CASE WHEN l.unit_cost_cents IS NOT NULL THEN ROUND(l.quantity_milli::numeric * l.unit_cost_cents / 1000) ELSE 0 END),0)::bigint AS cost,
             COUNT(*) FILTER (WHERE l.unit_cost_cents IS NULL)::int AS uncosted
        FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id AND i.business_id = l.business_id LEFT JOIN job_cards j ON j.id = i.job_id AND j.business_id = i.business_id
        LEFT JOIN memberships m ON m.id = l.technician_membership_id LEFT JOIN users u ON u.id = m.user_id
       WHERE l.business_id = ${bid}::uuid AND l.line_type = 'LABOUR' AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.invoice_date BETWEEN ${dateOnly(range.from)} AND ${dateOnly(range.to)}
         ${env.loc('i')} ${techL} ${svcJ} GROUP BY 1`);
    const keys = new Set<string>([...time.map((r) => r.k), ...lines.map((r) => r.k)]);
    const tm = new Map(time.map((r) => [r.k, r]));
    const lm = new Map(lines.map((r) => [r.k, r]));
    type Row = { period: string; label: string; worked: number; billable: number; nonBillable: number; billed: number; revenue: number; cost: number; margin: number };
    let rows: Row[] = [...keys].map((k) => {
      const t = tm.get(k), l = lm.get(k);
      const worked = n(t?.worked) / 60, billable = n(t?.billable) / 60, revenue = n(l?.revenue), cost = n(l?.cost);
      return { period: k, label: k, worked: Math.round(worked * 10) / 10, billable: Math.round(billable * 10) / 10, nonBillable: Math.round((worked - billable) * 10) / 10, billed: Math.round((n(l?.minutes) / 60) * 10) / 10, revenue, cost, margin: revenue - cost };
    });
    if (unit) rows = fillPeriods(env, unit, rows, (p) => ({ period: p, label: p, worked: 0, billable: 0, nonBillable: 0, billed: 0, revenue: 0, cost: 0, margin: 0 })).map((r) => ({ ...r, label: periodLabel(r.period, unit) }));
    else rows.sort((a, b) => b.revenue - a.revenue || a.label.localeCompare(b.label));
    const sum = (k: 'worked' | 'billable' | 'nonBillable' | 'billed' | 'revenue' | 'cost' | 'margin') => rows.reduce((a, r) => a + r[k], 0);
    const uncosted = lines.reduce((a, r) => a + r.uncosted, 0);
    return {
      columns: [
        col('group', group === 'technician' ? 'Technician' : group === 'service' ? 'Service' : unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month', 'text'),
        col('worked', 'Hours worked', 'hours'), col('billable', 'Billable hours worked', 'hours'), col('nonBillable', 'Non-billable hours', 'hours'), col('billed', 'Hours invoiced', 'hours'),
        col('revenue', 'Labour revenue (ex VAT)', 'money'), col('cost', 'Labour cost', 'money', { needs: 'labour.view_costs' }), col('margin', 'Gross labour margin', 'money', { needs: 'labour.view_costs' }),
      ],
      rows: rows.map((r) => ({ group: r.label, worked: r.worked, billable: r.billable, nonBillable: r.nonBillable, billed: r.billed, revenue: r.revenue, cost: r.cost, margin: r.margin })),
      summary: [
        { key: 'worked', label: 'Hours worked', value: Math.round(sum('worked') * 10) / 10, type: 'hours' },
        { key: 'billable', label: 'Billable hours worked', value: Math.round(sum('billable') * 10) / 10, type: 'hours' },
        { key: 'nonBillable', label: 'Non-billable hours', value: Math.round(sum('nonBillable') * 10) / 10, type: 'hours' },
        { key: 'revenue', label: 'Labour revenue (ex VAT)', value: sum('revenue'), type: 'money' },
        { key: 'cost', label: 'Labour cost', value: sum('cost'), type: 'money', needs: 'labour.view_costs' },
        { key: 'margin', label: 'Gross labour margin', value: sum('margin'), type: 'money', needs: 'labour.view_costs', hint: uncosted ? `${uncosted} labour line${uncosted === 1 ? '' : 's'} had no cost recorded` : undefined },
      ],
      charts: [bar('Labour revenue', 'money', rows.map((r) => r.label), [{ name: 'Revenue (ex VAT)', values: rows.map((r) => r.revenue) }, { name: 'Cost', values: rows.map((r) => r.cost), needs: 'labour.view_costs' }], unit ? 'line' : 'bar')],
      notes: [
        'Hours worked are completed time entries by start date. Revenue, hours invoiced and cost come from labour lines on issued invoices by invoice date; the rate and cost in force when each line was created are kept, so changing a rate never rewrites earlier work.',
        'Labour with no cost recorded counts as zero cost and is flagged; margin is gross labour margin, not profit.',
      ],
    };
  },
};

export const PEOPLE: ReportDef[] = [technicians, labour];
