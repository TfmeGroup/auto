import { z } from 'zod';
import { AppError, Errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { addDays, parseIsoDate, todayIso, weekdayOf, zonedToUtc } from '@/lib/tz';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { prisma, withTenant } from '@/server/db/client';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import { assertCanWrite, loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { enqueue } from '@/server/jobs/queue';
import { JobTypes } from '@/server/jobs/types';
import { storeFile } from '@/server/files/store';
import { sendCustomerMessage } from '@/server/notifications/comms';
import { notifyInApp } from '@/server/notifications/service';
import { requirePermission } from '@/server/permissions/authorize';
import { cleanupImports } from '@/server/imports/service';
import { memberNames } from '@/server/workshop/people';
import { systemMeta, type BusinessContext } from '@/server/context';
import { renderExport, type ExportFormat } from './export';
import { contextForMembership } from './recipient';
import { runStored, type SavedRow } from './saved';

/**
 * Scheduled reports:  saved report -> scheduler -> (per recipient) generate with THAT person's permissions -> export file -> email through the
 * shared message service (so it is in the communication history) -> run recorded.
 * A recipient who lost access is skipped and the skip is recorded; a run that delivers to nobody, or fails, is recorded as FAILED, retried
 * a few times, audited and raised to the person who set it up. Nothing reports success it did not achieve.
 */

export const scheduleSchema = z.object({
  savedReportId: z.uuid(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  weekday: z.coerce.number().int().min(0).max(6).optional(),
  monthDay: z.coerce.number().int().min(1).max(28).optional(),
  hour: z.coerce.number().int().min(0).max(23).default(7),
  format: z.enum(['CSV', 'XLSX', 'PDF']).default('CSV'),
  recipientMembershipIds: z.array(z.uuid()).max(25).optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
});

/** The first scheduled moment strictly after `after`, on the business calendar. */
export function computeNextRun(after: Date, s: { frequency: string; weekday?: number | null; monthDay?: number | null; hour: number }, tz: string): Date {
  const start = todayIso(tz, after);
  for (let i = 0; i <= 62; i++) {
    const day = addDays(start, i);
    const p = parseIsoDate(day)!;
    const matches = s.frequency === 'DAILY' || (s.frequency === 'WEEKLY' && weekdayOf(day) === s.weekday) || (s.frequency === 'MONTHLY' && p.day === s.monthDay);
    if (!matches) continue;
    const at = zonedToUtc(p.year, p.month, p.day, s.hour * 60, tz);
    if (at > after) return at;
  }
  throw Errors.validation({ frequency: 'That schedule never runs.' });
}

async function assertRecipientsMayReceive(ctx: BusinessContext, saved: SavedRow, ids: string[]): Promise<void> {
  for (const id of ids) {
    const rctx = await contextForMembership(ctx.business.id, id);
    if (!rctx) throw Errors.validation({ recipients: 'Choose active members of this business.' });
    try {
      await runStored(rctx, saved, { page: 1, pageSize: 10 });
    } catch (e) {
      if (e instanceof AppError && (e.code === 'FORBIDDEN' || e.code === 'FEATURE_NOT_IN_PLAN')) throw Errors.validation({ recipients: `${rctx.user.name} cannot see this report, so it will not be sent to them.` });
      throw e;
    }
  }
}

async function loadSaved(ctx: BusinessContext, id: string): Promise<SavedRow> {
  const row = await withTenant(ctx.business.id, (tx) => tx.savedReport.findFirst({ where: { id, businessId: ctx.business.id, archivedAt: null } }));
  if (!row) throw Errors.notFound('Report');
  // You can only schedule a report you could open yourself.
  await runStored(ctx, row, { page: 1, pageSize: 10 });
  return row;
}

export async function listSchedules(ctx: BusinessContext) {
  requirePermission(ctx, 'report.manage_scheduled');
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.reportSchedule.findMany({ where: { businessId: ctx.business.id }, orderBy: { createdAt: 'desc' }, include: { report: { select: { name: true, kind: true } }, runs: { orderBy: { createdAt: 'desc' }, take: 5 } } });
    const ids = rows.flatMap((r) => r.recipientMembershipIds);
    const names = await memberNames(tx, ctx.business.id, [...ids, ...rows.map((r) => r.createdByMembershipId)]);
    return rows.map((r) => ({
      id: r.id, report: r.report.name, savedReportId: r.savedReportId, frequency: r.frequency, weekday: r.weekday, monthDay: r.monthDay, hour: r.hour, format: r.format, status: r.status, nextRunAt: r.nextRunAt, lastRunAt: r.lastRunAt, lastStatus: r.lastStatus,
      recipients: r.recipientMembershipIds.map((id) => ({ id, name: names.get(id) ?? 'Former member' })), createdBy: names.get(r.createdByMembershipId) ?? 'Former member',
      runs: r.runs.map((x) => ({ id: x.id, dueAt: x.dueAt, status: x.status, sent: x.recipientsSent, skipped: x.recipientsSkipped, error: x.error, attempts: x.attempts, finishedAt: x.finishedAt })),
    }));
  });
}

export async function createSchedule(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'report.manage_scheduled');
  requireFeature(ctx.subscription, 'scheduled_reports');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(scheduleSchema, input);
  if (d.frequency === 'WEEKLY' && d.weekday === undefined) throw Errors.validation({ weekday: 'Choose a day of the week.' });
  if (d.frequency === 'MONTHLY' && d.monthDay === undefined) throw Errors.validation({ monthDay: 'Choose a day of the month (1 to 28).' });
  const saved = await loadSaved(ctx, d.savedReportId);
  const recipients = [...new Set(d.recipientMembershipIds?.length ? d.recipientMembershipIds : [ctx.membership.id])];
  await assertRecipientsMayReceive(ctx, saved, recipients);
  const next = computeNextRun(new Date(), d, ctx.business.timezone);
  return withTenant(ctx.business.id, async (tx) => {
    if ((await tx.reportSchedule.count({ where: { businessId: ctx.business.id } })) >= 50) throw Errors.conflict('This business has 50 scheduled reports. Remove one first.');
    const row = await tx.reportSchedule.create({
      data: {
        businessId: ctx.business.id, savedReportId: saved.id, frequency: d.frequency, weekday: d.frequency === 'WEEKLY' ? d.weekday! : null, monthDay: d.frequency === 'MONTHLY' ? d.monthDay! : null,
        hour: d.hour, format: d.format, recipientMembershipIds: recipients, nextRunAt: next, createdByMembershipId: ctx.membership.id,
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.reportScheduled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'report_schedule', resourceId: row.id, metadata: { report: saved.name, frequency: d.frequency, format: d.format, recipients: recipients.length } });
    return { id: row.id, nextRunAt: next };
  });
}

export async function updateSchedule(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'report.manage_scheduled');
  requireFeature(ctx.subscription, 'scheduled_reports');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(scheduleSchema.omit({ savedReportId: true }).partial(), input);
  const cur = await withTenant(ctx.business.id, (tx) => tx.reportSchedule.findFirst({ where: { id: parseOrThrow(uuidSchema, id), businessId: ctx.business.id }, include: { report: true } }));
  if (!cur) throw Errors.notFound('Schedule');
  const next: { frequency: string; weekday: number | null; monthDay: number | null; hour: number } = {
    frequency: d.frequency ?? cur.frequency, weekday: d.weekday ?? cur.weekday, monthDay: d.monthDay ?? cur.monthDay, hour: d.hour ?? cur.hour,
  };
  if (next.frequency === 'WEEKLY' && next.weekday === null) throw Errors.validation({ weekday: 'Choose a day of the week.' });
  if (next.frequency === 'MONTHLY' && next.monthDay === null) throw Errors.validation({ monthDay: 'Choose a day of the month (1 to 28).' });
  const recipients = d.recipientMembershipIds ? [...new Set(d.recipientMembershipIds)] : null;
  if (recipients) {
    if (!recipients.length) throw Errors.validation({ recipients: 'Choose at least one recipient.' });
    await assertRecipientsMayReceive(ctx, cur.report, recipients);
  }
  return withTenant(ctx.business.id, async (tx) => {
    const when = computeNextRun(new Date(), next, ctx.business.timezone);
    await tx.reportSchedule.update({
      where: { id: cur.id },
      data: { frequency: next.frequency, weekday: next.frequency === 'WEEKLY' ? next.weekday : null, monthDay: next.frequency === 'MONTHLY' ? next.monthDay : null, hour: next.hour, ...(d.format ? { format: d.format } : {}), ...(recipients ? { recipientMembershipIds: recipients } : {}), ...(d.status ? { status: d.status } : {}), nextRunAt: when },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.reportScheduleChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'report_schedule', resourceId: cur.id, metadata: { report: cur.report.name, status: d.status, frequency: next.frequency, recipients: recipients?.length } });
    return { id: cur.id, nextRunAt: when };
  });
}

export async function deleteSchedule(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'report.manage_scheduled');
  assertCanWrite(ctx.subscription);
  return withTenant(ctx.business.id, async (tx) => {
    const cur = await tx.reportSchedule.findFirst({ where: { id: parseOrThrow(uuidSchema, id), businessId: ctx.business.id }, include: { report: { select: { name: true } } } });
    if (!cur) throw Errors.notFound('Schedule');
    await tx.reportRun.deleteMany({ where: { scheduleId: cur.id, businessId: ctx.business.id } });
    await tx.reportSchedule.delete({ where: { id: cur.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.reportScheduleChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'report_schedule', resourceId: cur.id, metadata: { report: cur.report.name, removed: true } });
    return { id: cur.id };
  });
}

// ───────────────────────── the scheduler ─────────────────────────

export interface ReportTickResult { enqueued: number; cleaned: number }
let lastCleanup = 0;

/** Called by the minute scheduler. Idempotent: a due moment is claimed once (unique schedule + due time), so any number of workers is safe. */
export async function runDueReports(now = new Date()): Promise<ReportTickResult> {
  const out: ReportTickResult = { enqueued: 0, cleaned: 0 };
  const businesses = await prisma().business.findMany({ where: { status: 'ACTIVE' }, select: { id: true, timezone: true } });
  const cleanup = now.getTime() - lastCleanup > 3_600_000;
  if (cleanup) lastCleanup = now.getTime();
  for (const b of businesses) {
    try {
      const due = await withTenant(b.id, (tx) => tx.reportSchedule.findMany({ where: { businessId: b.id, status: 'ACTIVE', nextRunAt: { lte: now } } }));
      for (const s of due) {
        const claimed = await withTenant(b.id, async (tx) => {
          // A missed stretch (server down) produces ONE run for the latest due moment, not a burst.
          const fresh = await tx.reportSchedule.updateMany({ where: { id: s.id, businessId: b.id, nextRunAt: s.nextRunAt }, data: { nextRunAt: computeNextRun(now, s, b.timezone) } });
          if (fresh.count !== 1) return null;
          const run = await tx.reportRun.createManyAndReturn({ data: [{ businessId: b.id, scheduleId: s.id, dueAt: s.nextRunAt }], skipDuplicates: true });
          if (!run[0]) return null;
          await enqueue(tx, JobTypes.reportDeliver, { businessId: b.id, runId: run[0].id }, { dedupeKey: `report-run:${run[0].id}`, businessId: b.id, maxAttempts: 4 });
          return run[0].id;
        });
        if (claimed) out.enqueued++;
      }
      if (cleanup) out.cleaned += await cleanupBusiness(b.id, now);
    } catch (err) {
      logger.error({ businessId: b.id, err: String(err) }, 'report scheduling failed for a business');
    }
  }
  return out;
}

/** Old run records and the report files they delivered are cleared after the business's retention period (default 90 days). */
async function cleanupBusiness(businessId: string, now: Date): Promise<number> {
  return withTenant(businessId, async (tx) => {
    const cfg = await tx.businessConfig.findUnique({ where: { businessId } });
    const days = cfg?.reportRunRetentionDays ?? 90;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const runs = await tx.reportRun.deleteMany({ where: { businessId, createdAt: { lt: cutoff } } });
    // Delivered report files go to the trash (and are then removed by the normal trash cleanup); nothing else is touched.
    const files = await tx.file.updateMany({ where: { businessId, generatedKind: 'scheduled_report', status: 'ACTIVE', createdAt: { lt: cutoff } }, data: { status: 'TRASHED', trashedAt: now } });
    return runs.count + files.count + (await cleanupImports(tx, businessId, now));
  });
}

// ───────────────────────── the job ─────────────────────────

const MAX_ATTEMPTS = 4;
const ext: Record<ExportFormat, string> = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' };
const SAFE_FAILURE = 'The report could not be generated or sent.';

interface RunDetail { sent: string[]; skipped: { member: string; reason: string }[] }

export async function runScheduledReport(p: { businessId: string; runId: string }, attempt: number): Promise<void> {
  const { businessId } = p;
  const loaded = await withTenant(businessId, async (tx) => {
    const run = await tx.reportRun.findFirst({ where: { id: p.runId, businessId }, include: { schedule: { include: { report: true } } } });
    if (!run || ['SENT', 'FAILED', 'PARTIAL'].includes(run.status)) return null;
    await tx.reportRun.update({ where: { id: run.id }, data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: run.startedAt ?? new Date() } });
    return run;
  });
  if (!loaded) return;
  const { schedule } = loaded;
  const saved = schedule.report;
  const detail: RunDetail = { sent: [], skipped: [], ...((loaded.detail as Partial<RunDetail> | null) ?? {}) };
  const errors: string[] = [];

  const finish = async (status: 'SENT' | 'FAILED' | 'PARTIAL', error: string | null) => {
    await withTenant(businessId, async (tx) => {
      await tx.reportRun.update({ where: { id: loaded.id }, data: { status, error, detail: detail as never, recipientsSent: detail.sent.length, recipientsSkipped: detail.skipped.length, finishedAt: new Date() } });
      await tx.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: new Date(), lastStatus: status } });
      await recordAudit(tx, systemMeta('report'), {
        action: status === 'FAILED' ? AuditActions.reportDeliveryFailed : AuditActions.reportDelivered, businessId, resourceType: 'report_schedule', resourceId: schedule.id,
        metadata: { report: saved.name, status, sent: detail.sent.length, skipped: detail.skipped.length },
      });
      if (status !== 'SENT') {
        const owner = await tx.membership.findFirst({ where: { id: schedule.createdByMembershipId, businessId, status: 'ACTIVE' }, select: { userId: true } });
        if (owner?.userId) await notifyInApp(tx, { businessId, userId: owner.userId, type: 'REPORT_FAILED', title: `Scheduled report "${saved.name}" did not go out`, body: error ?? SAFE_FAILURE, linkUrl: '/reports/schedules', priority: 'HIGH', entityType: 'report_schedule', entityId: schedule.id });
      }
    });
  };

  if (schedule.status !== 'ACTIVE' || saved.archivedAt) { await finish('FAILED', 'The schedule was switched off before it ran.'); return; }
  const sub = await loadEffectiveSubscription(prisma(), businessId);
  if (!sub.features.has('scheduled_reports')) { await finish('FAILED', 'Scheduled reports are not included in the current plan.'); return; }

  for (const membershipId of schedule.recipientMembershipIds) {
    if (detail.sent.includes(membershipId)) continue;
    const rctx = await contextForMembership(businessId, membershipId);
    if (!rctx) { detail.skipped.push({ member: membershipId, reason: 'No longer an active member.' }); continue; }
    try {
      const result = await runStored(rctx, saved, {}, { all: true });
      const file = await renderExport(rctx, result, schedule.format as ExportFormat, result.columns);
      const stored = await storeFile({
        businessId, actorId: null, data: file.data, filename: file.filename, mime: file.mime, ext: ext[schedule.format as ExportFormat], resourceType: 'business', resourceId: businessId,
        category: 'REPORT', visibility: 'RESTRICTED', source: 'GENERATED', generatedKind: 'scheduled_report', generatedRef: `run:${loaded.id}:${membershipId}`, enforceStorageLimit: false,
        description: `Scheduled report "${saved.name}" for ${rctx.user.name}`,
      });
      const outcome = await withTenant(businessId, (tx) =>
        sendCustomerMessage(tx, businessId, {
          event: 'REPORT_DELIVERY', contact: { email: rctx.user.email, name: rctx.user.name }, entity: { type: 'saved_report', id: saved.id }, attachmentFileIds: [stored.id],
          dedupeKey: `report:${loaded.id}:${membershipId}`, vars: { report_name: saved.name, report_period: result.range ? `${result.range.from} to ${result.range.to}` : 'today' },
        }),
      );
      if (outcome.some((o) => o.status === 'queued' || o.status === 'duplicate')) detail.sent.push(membershipId);
      else detail.skipped.push({ member: membershipId, reason: outcome[0]?.detail ?? 'The message could not be queued.' });
    } catch (e) {
      if (e instanceof AppError && ['FORBIDDEN', 'FEATURE_NOT_IN_PLAN', 'VALIDATION_ERROR', 'NOT_FOUND'].includes(e.code)) detail.skipped.push({ member: membershipId, reason: e.code === 'FORBIDDEN' ? 'No longer has permission to see this report.' : e.message });
      else { logger.error({ runId: loaded.id, err: String(e) }, 'scheduled report generation failed'); errors.push(SAFE_FAILURE); }
    }
    await withTenant(businessId, (tx) => tx.reportRun.update({ where: { id: loaded.id }, data: { detail: detail as never } }));
  }

  if (errors.length) {
    if (attempt < MAX_ATTEMPTS) {
      await withTenant(businessId, (tx) => tx.reportRun.update({ where: { id: loaded.id }, data: { status: 'QUEUED', error: SAFE_FAILURE, detail: detail as never } }));
      throw new Error('report delivery will be retried');
    }
    await finish(detail.sent.length ? 'PARTIAL' : 'FAILED', SAFE_FAILURE);
    return;
  }
  if (detail.sent.length === 0) { await finish('FAILED', `Nobody could receive this report. ${detail.skipped.map((s) => s.reason).join(' ')}`.trim().slice(0, 300)); return; }
  await finish('SENT', null);
}

