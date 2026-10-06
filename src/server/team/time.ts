import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { minutesAmount } from '@/lib/money';
import { loadConfig } from '@/server/settings/config';
import { billedMinutes } from '@/server/settings/config-service';
import { dayRange } from '@/lib/tz';
import { optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { loadJob, loadJobForWrite } from '@/server/jobcards/common';
import { MAX_ENTRY_MINUTES, minutesBetween } from '@/server/inventory/calc';
import { memberNames } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import { resolveBillableRate } from './labour';

/**
 * Time on jobs. Everything lives on the server: a running timer is a row with a start time and no end, so a refresh, a closed browser or a
 * lost connection loses nothing; the elapsed time is always "now minus start", worked out by the server. Starting and stopping are
 * idempotent (a double tap or a retry gives the same answer), a person can have only one timer running (the database enforces it), and
 * a manual entry is refused if it is backwards, in the future, longer than a day, before the job was opened, or overlaps other time the same
 * person logged. Entries are never deleted: they are voided with a reason, edits keep who/when/why, and time that has become a labour line
 * is locked (the labour line carries the rate in force when it was posted).
 */

export const ENTRY_STATUS_LABEL: Record<string, string> = { RUNNING: 'Running', COMPLETED: 'Completed', VOIDED: 'Voided' };
const FUTURE_TOLERANCE_MS = 60_000;

const guard = (ctx: BusinessContext) => {
  requireFeature(ctx.subscription, 'technician_management');
  assertCanWrite(ctx.subscription);
};

async function lockPerson(tx: Tx, businessId: string, membershipId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`timer:${businessId}:${membershipId}`}, 0))`;
}

type EntryRow = Awaited<ReturnType<Tx['timeEntry']['findFirstOrThrow']>>;

async function present(tx: Tx, ctx: BusinessContext, e: EntryRow, now = new Date()) {
  const job = await tx.jobCard.findFirst({ where: { id: e.jobId, businessId: ctx.business.id }, select: { jobNumber: true } });
  const names = await memberNames(tx, ctx.business.id, [e.membershipId]);
  return {
    id: e.id, membershipId: e.membershipId, personName: names.get(e.membershipId) ?? 'Former member', jobId: e.jobId, jobNumber: job?.jobNumber ?? '', status: e.status, source: e.source, startedAt: e.startedAt, endedAt: e.endedAt,
    durationMinutes: e.status === 'RUNNING' ? minutesBetween(e.startedAt, now) : e.durationMinutes, elapsedSeconds: e.status === 'RUNNING' ? Math.max(0, Math.floor((now.getTime() - e.startedAt.getTime()) / 1000)) : null,
    billable: e.billable, notes: e.notes, posted: !!e.jobLabourId, approvedAt: e.approvedAt, voidReason: e.voidReason, editCount: e.editCount,
  };
}

// ───────── Timer ─────────

export const startSchema = z.object({ jobId: uuidSchema, notes: optionalText(300), billable: z.boolean().optional(), idempotencyKey: z.string().trim().min(8).max(100).optional() });

export async function startTimer(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'time.record');
  guard(ctx);
  const d = parseOrThrow(startSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await lockPerson(tx, ctx.business.id, ctx.membership.id);
    if (d.idempotencyKey) {
      const prior = await tx.timeEntry.findFirst({ where: { businessId: ctx.business.id, membershipId: ctx.membership.id, idempotencyKey: d.idempotencyKey } });
      if (prior) return { ...(await present(tx, ctx, prior)), replayed: true };
    }
    const running = await tx.timeEntry.findFirst({ where: { businessId: ctx.business.id, membershipId: ctx.membership.id, status: 'RUNNING' } });
    if (running) {
      if (running.jobId === d.jobId) return { ...(await present(tx, ctx, running)), replayed: true };
      const other = await tx.jobCard.findFirst({ where: { id: running.jobId, businessId: ctx.business.id }, select: { jobNumber: true } });
      throw Errors.conflict(`You already have a timer running on job ${other?.jobNumber ?? ''}. Stop it first.`, { code: 'TIMER_RUNNING', jobId: running.jobId });
    }
    const job = await loadJobForWrite(tx, ctx, d.jobId);
    const now = new Date();
    const e = await tx.timeEntry.create({ data: { businessId: ctx.business.id, membershipId: ctx.membership.id, jobId: job.id, status: 'RUNNING', source: 'TIMER', startedAt: now, billable: d.billable ?? true, notes: d.notes ?? null, idempotencyKey: d.idempotencyKey ?? null, createdById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.timeEntryStarted, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'time_entry', resourceId: e.id, metadata: { jobId: job.id, jobNumber: job.jobNumber } });
    return { ...(await present(tx, ctx, e, now)), replayed: false };
  });
}

export const stopSchema = z.object({ postToLabour: z.boolean().optional(), notes: optionalText(300) });

export async function stopTimer(ctx: BusinessContext, input: unknown = {}) {
  requirePermission(ctx, 'time.record');
  guard(ctx);
  const d = parseOrThrow(stopSchema, input ?? {});
  return withTenant(ctx.business.id, async (tx) => {
    await lockPerson(tx, ctx.business.id, ctx.membership.id);
    const running = await tx.timeEntry.findFirst({ where: { businessId: ctx.business.id, membershipId: ctx.membership.id, status: 'RUNNING' } });
    if (!running) {
      // A second "stop" (a retry after a lost response) answers with the entry that was just stopped.
      const last = await tx.timeEntry.findFirst({ where: { businessId: ctx.business.id, membershipId: ctx.membership.id, status: 'COMPLETED', source: 'TIMER' }, orderBy: { endedAt: 'desc' } });
      if (last?.endedAt && Date.now() - last.endedAt.getTime() < 30_000) return { ...(await present(tx, ctx, last)), replayed: true };
      throw Errors.conflict('You have no timer running.');
    }
    const now = new Date();
    const minutes = minutesBetween(running.startedAt, now);
    if (minutes > MAX_ENTRY_MINUTES) throw Errors.conflict('This timer has been running for more than 24 hours. Ask a manager to correct the time.', { code: 'TIMER_TOO_LONG' });
    if (now <= running.startedAt) throw Errors.conflict('The timer cannot be stopped before it started.');
    const stopped = await tx.timeEntry.update({ where: { id: running.id }, data: { status: 'COMPLETED', endedAt: now, durationMinutes: minutes, ...(d.notes ? { notes: d.notes } : {}) } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.timeEntryStopped, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'time_entry', resourceId: stopped.id, metadata: { jobId: stopped.jobId, minutes } });
    if (d.postToLabour && stopped.billable && minutes >= 1) await postToLabourTx(tx, ctx, stopped);
    const fresh = await tx.timeEntry.findFirstOrThrow({ where: { id: stopped.id } });
    return { ...(await present(tx, ctx, fresh, now)), replayed: false };
  });
}

/** The caller's own running timer, if any (this is what a page asks after a refresh or when the app comes back to the foreground). */
export async function getRunningTimer(ctx: BusinessContext) {
  requirePermission(ctx, 'time.record');
  return withTenant(ctx.business.id, async (tx) => {
    const e = await tx.timeEntry.findFirst({ where: { businessId: ctx.business.id, membershipId: ctx.membership.id, status: 'RUNNING' } });
    return e ? present(tx, ctx, e) : null;
  });
}

// ───────── Manual entries ─────────

const when = z.coerce.date();

export const manualSchema = z.object({
  jobId: uuidSchema,
  membershipId: uuidSchema.optional(),
  startedAt: when,
  endedAt: when.optional(),
  durationMinutes: z.coerce.number().int().min(1).max(MAX_ENTRY_MINUTES).optional(),
  billable: z.boolean().optional(),
  notes: optionalText(300),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
}).refine((d) => d.endedAt || d.durationMinutes, { message: 'Give the end time or the duration.', path: ['endedAt'] });

/** Check one interval against the rules every entry must obey. `ignoreId` is the entry being edited. */
async function assertValidInterval(tx: Tx, ctx: BusinessContext, o: { membershipId: string; job: { id: string; openedAt: Date }; start: Date; end: Date; ignoreId?: string; now: Date }) {
  if (!(o.end > o.start)) throw Errors.validation({ endedAt: 'The end time must be after the start time.' });
  if (o.end.getTime() > o.now.getTime() + FUTURE_TOLERANCE_MS) throw Errors.validation({ endedAt: 'Time cannot be in the future.' });
  const minutes = minutesBetween(o.start, o.end);
  if (minutes > MAX_ENTRY_MINUTES) throw Errors.validation({ endedAt: 'One entry cannot be longer than 24 hours.' });
  if (minutes < 1) throw Errors.validation({ endedAt: 'An entry must be at least one minute.' });
  if (o.start < o.job.openedAt) throw Errors.validation({ startedAt: 'That is before the job was opened.' });
  const clash = await tx.timeEntry.findFirst({
    where: { businessId: ctx.business.id, membershipId: o.membershipId, status: { not: 'VOIDED' }, ...(o.ignoreId ? { id: { not: o.ignoreId } } : {}), startedAt: { lt: o.end }, OR: [{ endedAt: null }, { endedAt: { gt: o.start } }] },
    select: { id: true },
  });
  if (clash) throw Errors.conflict('That overlaps other time already logged for this person.');
  return minutes;
}

export async function createManualEntry(ctx: BusinessContext, input: unknown) {
  guard(ctx);
  const d = parseOrThrow(manualSchema, input);
  const who = d.membershipId ?? ctx.membership.id;
  if (who === ctx.membership.id) requirePermission(ctx, 'time.record');
  else requirePermission(ctx, 'time.edit');
  return withTenant(ctx.business.id, async (tx) => {
    await lockPerson(tx, ctx.business.id, who);
    if (d.idempotencyKey) {
      const prior = await tx.timeEntry.findFirst({ where: { businessId: ctx.business.id, membershipId: who, idempotencyKey: d.idempotencyKey } });
      if (prior) return { ...(await present(tx, ctx, prior)), replayed: true };
    }
    const m = await tx.membership.findFirst({ where: { id: who, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } });
    if (!m) throw Errors.validation({ membershipId: 'Choose an active member of this business.' });
    // Managers may add time to a finished job; everyone else only to one still open.
    const job = can(ctx, 'time.edit') ? await (async () => { await loadJob(tx, ctx, d.jobId); return tx.jobCard.findFirstOrThrow({ where: { id: d.jobId, businessId: ctx.business.id } }); })() : await loadJobForWrite(tx, ctx, d.jobId);
    const now = new Date();
    const end = d.endedAt ?? new Date(d.startedAt.getTime() + d.durationMinutes! * 60_000);
    const minutes = await assertValidInterval(tx, ctx, { membershipId: who, job, start: d.startedAt, end, now });
    const e = await tx.timeEntry.create({ data: { businessId: ctx.business.id, membershipId: who, jobId: job.id, status: 'COMPLETED', source: 'MANUAL', startedAt: d.startedAt, endedAt: end, durationMinutes: minutes, billable: d.billable ?? true, notes: d.notes ?? null, idempotencyKey: d.idempotencyKey ?? null, createdById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.timeEntryCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'time_entry', resourceId: e.id, metadata: { jobId: job.id, membershipId: who, minutes, jobNumber: job.jobNumber } });
    return { ...(await present(tx, ctx, e)), replayed: false };
  });
}

const optionalWhen = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.date().optional());
export const editSchema = z.object({
  startedAt: optionalWhen,
  endedAt: optionalWhen,
  billable: z.boolean().optional(),
  notes: z.string().trim().max(300).nullish().transform((v) => (v === undefined ? undefined : v ? v : null)),
  reason: z.string().trim().min(3, 'Say why the time is being changed').max(300),
});

/** Is this labour line on an invoice that is not cancelled? Then the time behind it is part of a financial record. */
async function labourBilled(tx: Tx, businessId: string, labourId: string | null): Promise<boolean> {
  if (!labourId) return false;
  return !!(await tx.invoiceLine.findFirst({ where: { businessId, jobLabourId: labourId, invoice: { status: { not: 'CANCELLED' } } }, select: { id: true } }));
}

export async function editTimeEntry(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'time.edit');
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(editSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.timeEntry.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Time entry');
    await lockPerson(tx, ctx.business.id, before.membershipId);
    if (before.status === 'VOIDED') throw Errors.conflict('A voided entry cannot be changed.');
    if (before.jobLabourId) throw Errors.conflict((await labourBilled(tx, ctx.business.id, before.jobLabourId)) ? 'This time is on an invoice. Use a credit note to correct what the customer was charged.' : 'This time has already become a labour line. Void it (which removes the line) and enter it again.');
    const job = await tx.jobCard.findFirstOrThrow({ where: { id: before.jobId, businessId: ctx.business.id } });
    const start = d.startedAt ?? before.startedAt;
    const end = d.endedAt ?? before.endedAt;
    const data: Record<string, unknown> = { editCount: { increment: 1 } };
    if (end) {
      const minutes = await assertValidInterval(tx, ctx, { membershipId: before.membershipId, job, start, end, ignoreId: id, now: new Date() });
      Object.assign(data, { startedAt: start, endedAt: end, durationMinutes: minutes, status: 'COMPLETED' });
    } else if (d.startedAt) {
      if (d.startedAt < job.openedAt || d.startedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw Errors.validation({ startedAt: 'That start time is not possible.' });
      data.startedAt = d.startedAt;
    }
    if (d.billable !== undefined) data.billable = d.billable;
    if (d.notes !== undefined) data.notes = d.notes;
    const after = await tx.timeEntry.update({ where: { id }, data });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.timeEntryEdited, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'time_entry', resourceId: id,
      before: { startedAt: before.startedAt, endedAt: before.endedAt, durationMinutes: before.durationMinutes, billable: before.billable, notes: before.notes }, after: { startedAt: after.startedAt, endedAt: after.endedAt, durationMinutes: after.durationMinutes, billable: after.billable, notes: after.notes },
      metadata: { reason: d.reason, membershipId: before.membershipId, jobId: before.jobId },
    });
    return present(tx, ctx, after);
  });
}

export async function voidTimeEntry(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'time.edit');
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(z.object({ reason: z.string().trim().min(3, 'Say why').max(300) }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const e = await tx.timeEntry.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!e) throw Errors.notFound('Time entry');
    await lockPerson(tx, ctx.business.id, e.membershipId);
    if (e.status === 'VOIDED') return present(tx, ctx, e);
    if (e.jobLabourId) {
      if (await labourBilled(tx, ctx.business.id, e.jobLabourId)) throw Errors.conflict('This time is on an invoice. Use a credit note to correct what the customer was charged.');
      await tx.jobLabour.update({ where: { id: e.jobLabourId }, data: { archivedAt: new Date() } });
    }
    const now = new Date();
    const after = await tx.timeEntry.update({ where: { id }, data: { status: 'VOIDED', voidedAt: now, voidedById: ctx.user.id, voidReason: d.reason, jobLabourId: null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.timeEntryVoided, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'time_entry', resourceId: id, before: { status: e.status, durationMinutes: e.durationMinutes }, metadata: { reason: d.reason, jobId: e.jobId, membershipId: e.membershipId, removedLabourLine: !!e.jobLabourId } });
    return present(tx, ctx, after);
  });
}

export async function approveTimeEntry(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'time.approve');
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const e = await tx.timeEntry.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!e) throw Errors.notFound('Time entry');
    if (e.status !== 'COMPLETED') throw Errors.conflict('Only a completed entry can be approved.');
    if (e.approvedAt) return present(tx, ctx, e);
    const after = await tx.timeEntry.update({ where: { id }, data: { approvedAt: new Date(), approvedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.timeEntryApproved, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'time_entry', resourceId: id, metadata: { jobId: e.jobId, membershipId: e.membershipId } });
    return present(tx, ctx, after);
  });
}

// ───────── Time becomes labour ─────────

/** Turn a completed, billable entry into a labour line on the job, at the rate in force right now (copied onto the line). */
async function postToLabourTx(tx: Tx, ctx: BusinessContext, e: EntryRow) {
  if (e.status !== 'COMPLETED') throw Errors.conflict('Only a completed entry can become labour.');
  if (!e.billable) throw Errors.conflict('This time is marked non-billable.');
  if (e.jobLabourId) return e;
  const actual = Math.max(1, e.durationMinutes ?? 0);
  // What is BILLED can differ from what was worked: the business's rounding step and minimum apply. The time entry keeps the actual minutes.
  const rules = await loadConfig(tx, ctx.business.id);
  const minutes = billedMinutes(actual, rules);
  const job = await tx.jobCard.findFirstOrThrow({ where: { id: e.jobId, businessId: ctx.business.id } });
  const { rateCentsPerHour } = await resolveBillableRate(tx, ctx.business.id, { membershipId: e.membershipId, serviceTypeId: job.serviceTypeId });
  const labour = await tx.jobLabour.create({
    data: {
      businessId: ctx.business.id, jobId: e.jobId, technicianMembershipId: e.membershipId, description: `${e.notes ? `Labour — ${e.notes}` : 'Labour'}${minutes !== actual ? ` (worked ${actual} min, billed ${minutes} min)` : ''}`, minutes, rateCentsPerHour,
      totalCents: rateCentsPerHour != null ? minutesAmount(minutes, rateCentsPerHour) : null, recordedById: ctx.user.id,
    },
  });
  const after = await tx.timeEntry.update({ where: { id: e.id }, data: { jobLabourId: labour.id, postedAt: new Date() } });
  await recordAudit(tx, ctx.meta, { action: AuditActions.timeEntryPosted, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'time_entry', resourceId: e.id, metadata: { jobId: e.jobId, labourId: labour.id, minutes, workedMinutes: actual, rateCentsPerHour } });
  return after;
}

export async function postTimeToLabour(ctx: BusinessContext, id: string) {
  guard(ctx);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const e = await tx.timeEntry.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!e) throw Errors.notFound('Time entry');
    const own = e.membershipId === ctx.membership.id;
    if (!can(ctx, 'time.edit') && !(own && can(ctx, 'job.edit') && can(ctx, 'time.record'))) throw Errors.forbidden();
    await lockPerson(tx, ctx.business.id, e.membershipId);
    const after = await postToLabourTx(tx, ctx, e);
    return present(tx, ctx, after);
  });
}

// ───────── Lists ─────────

export const timeListSchema = paginationSchema.extend({
  membershipId: uuidSchema.optional(),
  jobId: uuidSchema.optional(),
  status: z.enum(['RUNNING', 'COMPLETED', 'VOIDED']).optional(),
  billable: z.enum(['1', '0']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** People without "view everyone's time" only ever see their own. */
export async function listTimeEntries(ctx: BusinessContext, query: unknown) {
  if (!can(ctx, 'time.view_all') && !can(ctx, 'time.record')) throw Errors.forbidden();
  requireFeature(ctx.subscription, 'technician_management');
  const q = parseOrThrow(timeListSchema, query);
  const everyone = can(ctx, 'time.view_all');
  const who = everyone ? q.membershipId : ctx.membership.id;
  if (!everyone && q.membershipId && q.membershipId !== ctx.membership.id) throw Errors.forbidden();
  return withTenant(ctx.business.id, async (tx) => {
    const where = {
      businessId: ctx.business.id, ...(who ? { membershipId: who } : {}), ...(q.jobId ? { jobId: q.jobId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.billable ? { billable: q.billable === '1' } : {}),
      ...(q.from || q.to ? { startedAt: { ...(q.from ? { gte: dayRange(q.from, ctx.business.timezone).start } : {}), ...(q.to ? { lt: dayRange(q.to, ctx.business.timezone).end } : {}) } } : {}),
    };
    const total = await tx.timeEntry.count({ where });
    const rows = await tx.timeEntry.findMany({ where, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize });
    const names = await memberNames(tx, ctx.business.id, rows.map((r) => r.membershipId));
    const jobs = new Map((await tx.jobCard.findMany({ where: { businessId: ctx.business.id, id: { in: [...new Set(rows.map((r) => r.jobId))] } }, select: { id: true, jobNumber: true } })).map((j) => [j.id, j.jobNumber]));
    const now = new Date();
    const sum = await tx.timeEntry.aggregate({ where: { ...where, status: 'COMPLETED' }, _sum: { durationMinutes: true } });
    const billableSum = await tx.timeEntry.aggregate({ where: { ...where, status: 'COMPLETED', billable: true }, _sum: { durationMinutes: true } });
    return {
      items: rows.map((e) => ({
        id: e.id, membershipId: e.membershipId, personName: names.get(e.membershipId) ?? 'Former member', jobId: e.jobId, jobNumber: jobs.get(e.jobId) ?? '', status: e.status, source: e.source, startedAt: e.startedAt, endedAt: e.endedAt,
        durationMinutes: e.status === 'RUNNING' ? minutesBetween(e.startedAt, now) : e.durationMinutes, billable: e.billable, notes: e.notes, posted: !!e.jobLabourId, approved: !!e.approvedAt, voidReason: e.voidReason, editCount: e.editCount,
      })),
      totals: { minutes: sum._sum.durationMinutes ?? 0, billableMinutes: billableSum._sum.durationMinutes ?? 0 },
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}
