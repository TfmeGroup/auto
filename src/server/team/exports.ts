import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { toCsv, toXlsx, type Cell, type Column } from '@/lib/tabular';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import type { BusinessContext } from '@/server/context';
import { listEmployees } from './directory';
import { getTeamWorkload } from './performance';
import { listTimeEntries } from './time';

/**
 * Team exports (CSV or Excel): the directory, technician workload and time entries. Needs report.export plus the permission for that kind of data.
 * Nothing about passwords, sign-ins, devices or two-factor settings is ever included, and labour revenue only for people who may see labour rates.
 */

const LIMIT = 20_000;
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
export const teamExportSchema = z.object({
  dataset: z.enum(['directory', 'workload', 'time_entries']),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  from: iso.optional(),
  to: iso.optional(),
  membershipId: uuidSchema.optional(),
  jobId: uuidSchema.optional(),
});

const col = (header: string, kind: Column['kind']): Column => ({ header, kind });
const T = 'text' as const;
const N = 'int' as const;
const M = 'money' as const;
const hours = (min: number | null) => (min === null ? '' : (min / 60).toFixed(2));

export async function exportTeam(ctx: BusinessContext, query: unknown): Promise<{ data: Buffer; filename: string; mime: string; rows: number }> {
  requirePermission(ctx, 'report.export');
  requireFeature(ctx.subscription, 'data_export');
  const q = parseOrThrow(teamExportSchema, query);
  await consume({ key: `team-export:${ctx.business.id}`, limit: 20, windowSec: 3600 });
  let title: string;
  let columns: Column[];
  let rows: Cell[][];
  if (q.dataset === 'directory') {
    requirePermission(ctx, 'employee.view');
    const all: Awaited<ReturnType<typeof listEmployees>>['items'] = [];
    for (let page = 1; page <= 200; page++) {
      const r = await listEmployees(ctx, { page, pageSize: 100, status: undefined });
      all.push(...r.items);
      if (page >= r.meta.totalPages) break;
    }
    title = 'Team';
    columns = [col('Name', T), col('Email', T), col('Phone', T), col('Role', T), col('Status', T), col('Technician', T), col('Locations', T), col('Joined', T), col('Last active', T)];
    rows = all.map((e) => [e.name, e.email, e.phone, e.role.name, e.status, e.isTechnician ? 'Yes' : 'No', e.locations, e.joinedAt ? e.joinedAt.toISOString().slice(0, 10) : '', e.lastActiveAt ? e.lastActiveAt.toISOString().slice(0, 10) : '']);
  } else if (q.dataset === 'workload') {
    requirePermission(ctx, 'employee.view_reports');
    const w = await getTeamWorkload(ctx, { from: q.from, to: q.to });
    const revenue = can(ctx, 'labour.view_rates');
    title = 'Technician workload';
    columns = [col('Technician', T), col('Jobs completed', N), col('Jobs open', N), col('Bookings', N), col('Booked hours', T), col('Worked hours', T), col('Billable hours', T), col('Available hours', T), col('Utilisation %', T), col('Average hours to complete a job', T), col('Parts fitted', N), ...(revenue ? [col('Labour recorded', M)] : [])];
    rows = w.items.map((t) => [t.name, t.jobsCompleted, t.jobsOpen, t.bookings, hours(t.bookedMinutes), hours(t.workedMinutes), hours(t.billableMinutes), hours(t.capacityMinutes), t.utilisationBps === null ? '' : (t.utilisationBps / 100).toFixed(1), t.avgCompletionHours === null ? '' : String(t.avgCompletionHours), t.partsFitted, ...(revenue ? [t.labourRevenueCents] : [])]);
  } else {
    if (!can(ctx, 'time.view_all')) throw Errors.forbidden();
    const all: Awaited<ReturnType<typeof listTimeEntries>>['items'] = [];
    for (let page = 1; page <= 200; page++) {
      const r = await listTimeEntries(ctx, { page, pageSize: 100, from: q.from, to: q.to, membershipId: q.membershipId, jobId: q.jobId });
      all.push(...r.items);
      if (page >= r.meta.totalPages || all.length > LIMIT) break;
    }
    title = 'Time entries';
    columns = [col('Person', T), col('Job', T), col('Status', T), col('Source', T), col('Started', T), col('Ended', T), col('Hours', T), col('Billable', T), col('Notes', T), col('Posted to labour', T), col('Approved', T), col('Void reason', T)];
    rows = all.map((e) => [e.personName, e.jobNumber, e.status, e.source, e.startedAt.toISOString(), e.endedAt ? e.endedAt.toISOString() : '', hours(e.durationMinutes), e.billable ? 'Yes' : 'No', e.notes, e.posted ? 'Yes' : 'No', e.approved ? 'Yes' : 'No', e.voidReason]);
  }
  if (rows.length > LIMIT) throw Errors.validation({ from: 'That is too many rows. Choose a shorter period.' });
  const data = q.format === 'xlsx' ? toXlsx(title, columns, rows) : toCsv(columns, rows);
  await withTenant(ctx.business.id, (tx) => recordAudit(tx, ctx.meta, { action: AuditActions.teamExported, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'team_export', resourceId: ctx.business.id, metadata: { dataset: q.dataset, format: q.format, rows: rows.length, from: q.from ?? null, to: q.to ?? null } }));
  return { data, filename: `tfme-auto-team-${q.dataset.replace(/_/g, '-')}-${new Date().toISOString().slice(0, 10)}.${q.format}`, mime: q.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8', rows: rows.length };
}
