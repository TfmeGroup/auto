import { loadConfig } from '@/server/settings/config';
import { z } from 'zod';
import { seq, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { can, requirePermission } from '@/server/permissions/authorize';
import { recordMileageTx } from '@/server/vehicles/service';
import { memberNames } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';

/**
 * Everything derived from a vehicle's recorded history: maintenance intervals, the health indicator, the
 * overview and the service history. All of it is computed from rows that exist (completed jobs,
 * inspections, recommended work, intervals) by explicit rules — there is no scoring model and no guesswork.
 */

// ───────────────────────── service intervals ─────────────────────────

export interface IntervalLike {
  everyKm: number | null;
  everyMonths: number | null;
  lastServiceAt: Date | null;
  lastServiceKm: number | null;
}

export interface IntervalStatus {
  nextDueAt: Date | null;
  nextDueKm: number | null;
  overdueByDate: boolean;
  overdueByKm: boolean;
  overdue: boolean;
  /** No previous service recorded: nothing can be computed until one is. */
  needsBaseline: boolean;
}

function addMonthsUtc(d: Date, months: number): Date {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes()));
}

/** Pure: when is the next service due, and is it overdue? Whichever limit (distance or time) comes first. */
export function intervalStatus(i: IntervalLike, currentKm: number | null, now: Date): IntervalStatus {
  const nextDueAt = i.everyMonths && i.lastServiceAt ? addMonthsUtc(i.lastServiceAt, i.everyMonths) : null;
  const nextDueKm = i.everyKm && i.lastServiceKm !== null ? i.lastServiceKm + i.everyKm : null;
  const overdueByDate = nextDueAt !== null && nextDueAt.getTime() < now.getTime();
  const overdueByKm = nextDueKm !== null && currentKm !== null && currentKm >= nextDueKm;
  return {
    nextDueAt, nextDueKm, overdueByDate, overdueByKm, overdue: overdueByDate || overdueByKm,
    needsBaseline: (i.everyMonths !== null && !i.lastServiceAt) || (i.everyKm !== null && i.lastServiceKm === null),
  };
}

export const intervalSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name, e.g. "Oil service"').max(80),
    serviceTypeId: uuidSchema.optional(),
    everyKm: z.union([z.literal(''), z.coerce.number().int().min(100).max(200_000)]).optional().transform((v) => (v === '' || v === undefined ? undefined : v)),
    everyMonths: z.union([z.literal(''), z.coerce.number().int().min(1).max(120)]).optional().transform((v) => (v === '' || v === undefined ? undefined : v)),
    lastServiceAt: z.union([z.literal(''), z.coerce.date()]).optional().transform((v) => (v === '' || v === undefined ? undefined : v)),
    lastServiceKm: z.union([z.literal(''), z.coerce.number().int().min(0).max(5_000_000)]).optional().transform((v) => (v === '' || v === undefined ? undefined : v)),
  })
  .superRefine((v, ctx) => {
    if (!v.everyKm && !v.everyMonths) ctx.addIssue({ code: 'custom', path: ['everyKm'], message: 'Set a distance, a number of months, or both' });
  });

export async function listIntervals(ctx: BusinessContext, vehicleId: string) {
  requirePermission(ctx, 'vehicle.view');
  const id = parseOrThrow(uuidSchema, vehicleId);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id, businessId: ctx.business.id }, select: { id: true, mileageKm: true } });
    if (!v) throw Errors.notFound('Vehicle');
    const rows = await tx.serviceInterval.findMany({ where: { businessId: ctx.business.id, vehicleId: id }, orderBy: { createdAt: 'asc' } });
    const now = new Date();
    return rows.map((r) => ({ ...r, status: intervalStatus(r, v.mileageKm, now) }));
  });
}

export async function addInterval(ctx: BusinessContext, vehicleId: string, input: unknown) {
  requirePermission(ctx, 'vehicle.edit');
  const id = parseOrThrow(uuidSchema, vehicleId);
  // With nothing typed for either, the business's default interval (Settings, Vehicles) is used.
  const defaults = await withTenant(ctx.business.id, (tx) => loadConfig(tx, ctx.business.id));
  const given = (input ?? {}) as Record<string, unknown>;
  const withDefaults = !given.everyKm && !given.everyMonths ? { ...given, everyKm: defaults.defaultIntervalKm ?? undefined, everyMonths: defaults.defaultIntervalMonths ?? undefined } : given;
  const data = parseOrThrow(intervalSchema, withDefaults);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!v) throw Errors.notFound('Vehicle');
    if (data.serviceTypeId) {
      const t = await tx.serviceType.findFirst({ where: { id: data.serviceTypeId, businessId: ctx.business.id }, select: { id: true } });
      if (!t) throw Errors.validation({ serviceTypeId: 'Choose a service type of this business.' });
    }
    const row = await tx.serviceInterval.create({
      data: {
        businessId: ctx.business.id, vehicleId: id, name: data.name, serviceTypeId: data.serviceTypeId ?? null,
        everyKm: data.everyKm ?? null, everyMonths: data.everyMonths ?? null,
        lastServiceAt: data.lastServiceAt ?? null, lastServiceKm: data.lastServiceKm ?? null,
      },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: id,
      metadata: { serviceIntervalAdded: row.id },
    });
    return row;
  });
}

export async function removeInterval(ctx: BusinessContext, vehicleId: string, intervalId: string) {
  requirePermission(ctx, 'vehicle.edit');
  const id = parseOrThrow(uuidSchema, vehicleId);
  const iid = parseOrThrow(uuidSchema, intervalId);
  return withTenant(ctx.business.id, async (tx) => {
    const r = await tx.serviceInterval.findFirst({ where: { id: iid, vehicleId: id, businessId: ctx.business.id } });
    if (!r) throw Errors.notFound('Service interval');
    await tx.serviceInterval.update({ where: { id: iid }, data: { active: false } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: id,
      metadata: { serviceIntervalDeactivated: iid },
    });
  });
}

/** Record that a maintenance item was just done (resets its clock). Also used automatically when a matching job completes. */
export async function markServiced(tx: Tx, businessId: string, vehicleId: string, intervalWhere: { id?: string; serviceTypeId?: string }, at: Date, km: number | null) {
  await tx.serviceInterval.updateMany({
    where: { businessId, vehicleId, active: true, ...intervalWhere },
    data: { lastServiceAt: at, lastServiceKm: km },
  });
}

export async function markIntervalServiced(ctx: BusinessContext, vehicleId: string, intervalId: string, input: unknown) {
  requirePermission(ctx, 'vehicle.edit');
  const id = parseOrThrow(uuidSchema, vehicleId);
  const iid = parseOrThrow(uuidSchema, intervalId);
  const { km, at } = parseOrThrow(
    z.object({
      km: z.union([z.literal(''), z.coerce.number().int().min(0).max(5_000_000)]).optional().transform((v) => (v === '' ? undefined : v)),
      at: z.union([z.literal(''), z.coerce.date()]).optional().transform((v) => (v === '' || v === undefined ? new Date() : v)),
    }),
    input,
  );
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!v) throw Errors.notFound('Vehicle');
    const r = await tx.serviceInterval.findFirst({ where: { id: iid, vehicleId: id, businessId: ctx.business.id, active: true } });
    if (!r) throw Errors.notFound('Service interval');
    // A reading given with the service goes into the mileage history too (and cannot go backwards).
    if (km !== undefined && km !== v.mileageKm) await recordMileageTx(tx, ctx.business.id, ctx.user.id, id, km, 'SERVICE', { note: `${r.name} serviced` });
    await markServiced(tx, ctx.business.id, id, { id: iid }, at, km ?? v.mileageKm);
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'vehicle.serviced', summary: `${r.name} recorded as done`, customerId: v.customerId, vehicleId: id,
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: id,
      metadata: { serviceIntervalServiced: iid },
    });
  });
}

// ───────────────────────── health indicator ─────────────────────────

export type HealthLevel = 'GOOD' | 'ATTENTION_RECOMMENDED' | 'IMMEDIATE_ATTENTION';

export interface HealthReport {
  level: HealthLevel;
  /** What the records say, each traceable to a job, inspection item, work item or interval. */
  facts: { text: string; jobId?: string }[];
  /** Work someone has recommended that has not been done (recommendations, not facts). */
  outstandingWork: { id: string; jobId: string; description: string; priority: string; approvalStatus: string }[];
  inspectedAt: Date | null;
}

/**
 * The deterministic vehicle health indicator. Rules, in order:
 *   IMMEDIATE ATTENTION — the latest completed inspection has an unresolved CRITICAL finding, or outstanding
 *                         recommended work is marked URGENT.
 *   ATTENTION RECOMMENDED — an unresolved ATTENTION finding, outstanding IMPORTANT/RECOMMENDED work, or an overdue
 *                         maintenance interval.
 *   GOOD — none of the above is recorded.
 * A finding is "resolved" once recommended work created from it has been completed; a newer inspection replaces an
 * older one. Nothing is inferred beyond these rows.
 */
export async function computeHealth(tx: Tx, businessId: string, vehicleId: string, now = new Date()): Promise<HealthReport> {
  const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId }, select: { mileageKm: true } });
  if (!vehicle) throw Errors.notFound('Vehicle');

  const inspection = await tx.inspection.findFirst({
    where: { businessId, vehicleId, status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    include: { items: { where: { status: { in: ['ATTENTION', 'CRITICAL'] } } } },
  });
  const work = await tx.recommendedWork.findMany({
    where: { businessId, archivedAt: null, completedAt: null, job: { vehicleId, status: { not: 'CANCELLED' } } },
    orderBy: { createdAt: 'asc' },
  });
  const resolvedItemIds = new Set(
    (await tx.recommendedWork.findMany({
      where: { businessId, sourceInspectionItemId: { in: inspection?.items.map((i) => i.id) ?? [] }, completedAt: { not: null } },
      select: { sourceInspectionItemId: true },
    })).map((w) => w.sourceInspectionItemId),
  );
  const open = (inspection?.items ?? []).filter((i) => !resolvedItemIds.has(i.id));
  const intervals = await tx.serviceInterval.findMany({ where: { businessId, vehicleId, active: true } });
  const overdue = intervals.map((i) => ({ i, s: intervalStatus(i, vehicle.mileageKm, now) })).filter((x) => x.s.overdue);

  const facts: HealthReport['facts'] = [];
  for (const it of open.filter((i) => i.status === 'CRITICAL')) facts.push({ text: `Inspection: ${it.label} recorded as critical`, jobId: inspection!.jobId });
  for (const it of open.filter((i) => i.status === 'ATTENTION')) facts.push({ text: `Inspection: ${it.label} recorded as needing attention`, jobId: inspection!.jobId });
  for (const w of work.filter((x) => x.priority === 'URGENT')) facts.push({ text: `Urgent work outstanding: ${w.description}`, jobId: w.jobId });
  for (const { i, s } of overdue) facts.push({ text: `${i.name} is overdue${s.overdueByDate ? ' by date' : ''}${s.overdueByKm ? ' by distance' : ''}` });

  const immediate = open.some((i) => i.status === 'CRITICAL') || work.some((w) => w.priority === 'URGENT');
  const attention = open.length > 0 || work.length > 0 || overdue.length > 0;
  return {
    level: immediate ? 'IMMEDIATE_ATTENTION' : attention ? 'ATTENTION_RECOMMENDED' : 'GOOD',
    facts,
    outstandingWork: work.map((w) => ({ id: w.id, jobId: w.jobId, description: w.description, priority: w.priority, approvalStatus: w.approvalStatus })),
    inspectedAt: inspection?.completedAt ?? null,
  };
}

// ───────────────────────── overview ─────────────────────────

/** The vehicle summary: live counts and dates, limited to what the caller may see. Financial totals arrive with Part 4. */
export async function getVehicleOverview(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'vehicle.view');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const businessId = ctx.business.id;
  return withTenant(businessId, async (tx) => {
    const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId }, include: { customer: { select: { id: true, name: true, customerNumber: true, mobile: true } }, contacts: { orderBy: { createdAt: 'asc' } } } });
    if (!vehicle) throw Errors.notFound('Vehicle');
    const seeJobs = can(ctx, 'job.view');
    const [totalJobs, lastService, activeJob, intervals] = await seq([
      seeJobs ? tx.jobCard.count({ where: { businessId, vehicleId } }) : null,
      seeJobs ? tx.jobCard.findFirst({ where: { businessId, vehicleId, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, select: { id: true, jobNumber: true, completedAt: true, mileageOutKm: true, mileageInKm: true } }) : null,
      seeJobs ? tx.jobCard.findFirst({ where: { businessId, vehicleId, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, orderBy: { openedAt: 'desc' }, select: { id: true, jobNumber: true, status: true } }) : null,
      tx.serviceInterval.findMany({ where: { businessId, vehicleId, active: true } }),
    ]);
    const health = seeJobs ? await computeHealth(tx, businessId, vehicleId) : null;
    const now = new Date();
    const due = intervals.map((i) => ({ name: i.name, ...intervalStatus(i, vehicle.mileageKm, now) }));
    const nextService = due.filter((d) => d.nextDueAt || d.nextDueKm !== null).sort((a, b) => (a.nextDueAt?.getTime() ?? Infinity) - (b.nextDueAt?.getTime() ?? Infinity))[0] ?? null;
    return {
      vehicle, totalJobs, lastService, activeJob, nextService,
      outstandingWork: health ? health.outstandingWork.length : null,
      health,
      financial: { available: false as const },
    };
  });
}

// ───────────────────────── service history ─────────────────────────

export const historyQuerySchema = paginationSchema;

/**
 * Service history: the vehicle's COMPLETED job cards, newest first. This reads the jobs themselves (work performed,
 * labour, fitted parts, technician, notes the customer may see) — there is no separate history table to fall out of
 * step. Pricing columns are only returned to people allowed to see job pricing.
 */
export async function listServiceHistory(ctx: BusinessContext, id: string, query: unknown) {
  requirePermission(ctx, 'vehicle.view');
  requirePermission(ctx, 'job.view');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const q = parseOrThrow(historyQuerySchema, query);
  const pricing = can(ctx, 'job.view_pricing');
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id }, select: { id: true } });
    if (!v) throw Errors.notFound('Vehicle');
    const where = { businessId: ctx.business.id, vehicleId, status: 'COMPLETED' as const };
    const [total, jobs] = await seq([
      tx.jobCard.count({ where }),
      tx.jobCard.findMany({ where, orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const jobIds = jobs.map((j) => j.id);
    const [work, labour, parts, photos] = await seq([
      tx.recommendedWork.findMany({ where: { businessId: ctx.business.id, jobId: { in: jobIds }, approvalStatus: 'APPROVED', archivedAt: null } }),
      tx.jobLabour.findMany({ where: { businessId: ctx.business.id, jobId: { in: jobIds }, archivedAt: null } }),
      tx.jobPart.findMany({ where: { businessId: ctx.business.id, jobId: { in: jobIds }, archivedAt: null, status: 'FITTED' } }),
      tx.jobPhoto.groupBy({ by: ['jobId'], where: { businessId: ctx.business.id, jobId: { in: jobIds }, archivedAt: null }, _count: true }),
    ]);
    const names = await memberNames(tx, ctx.business.id, [...jobs.map((j) => j.primaryTechnicianMembershipId), ...labour.map((l) => l.technicianMembershipId)]);
    const photoCount = new Map(photos.map((p) => [p.jobId, p._count]));
    return {
      items: jobs.map((j) => ({
        jobId: j.id, jobNumber: j.jobNumber, date: j.completedAt, mileageKm: j.mileageOutKm ?? j.mileageInKm,
        serviceType: j.serviceLabel, technician: j.primaryTechnicianMembershipId ? (names.get(j.primaryTechnicianMembershipId) ?? null) : null,
        summary: j.completionSummary,
        workPerformed: work.filter((w) => w.jobId === j.id).map((w) => w.description),
        parts: parts.filter((p) => p.jobId === j.id).map((p) => ({ description: p.description, partNumber: p.partNumber, quantity: p.quantity, ...(pricing ? { sellPriceCents: p.sellPriceCents } : {}) })),
        labour: labour.filter((l) => l.jobId === j.id).map((l) => ({
          description: l.description, minutes: l.minutes, technician: l.technicianMembershipId ? (names.get(l.technicianMembershipId) ?? null) : null,
          ...(pricing ? { totalCents: l.totalCents } : {}),
        })),
        photoCount: photoCount.get(j.id) ?? 0,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}


// ───────────────────────── parts and photos across a vehicle's jobs ─────────────────────────

/** Parts recorded on this vehicle's jobs (the Parts tab). The inventory module of Part 5 will enrich the same rows. */
export async function listVehicleParts(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'vehicle.view');
  requirePermission(ctx, 'job.view');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const pricing = can(ctx, 'job.view_pricing');
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id }, select: { id: true } });
    if (!v) throw Errors.notFound('Vehicle');
    const rows = await tx.jobPart.findMany({
      where: { businessId: ctx.business.id, archivedAt: null, job: { vehicleId } },
      orderBy: { createdAt: 'desc' }, take: 200, include: { job: { select: { id: true, jobNumber: true, completedAt: true, openedAt: true } } },
    });
    return rows.map((p) => ({
      id: p.id, description: p.description, partNumber: p.partNumber, quantity: p.quantity, status: p.status, jobId: p.job.id, jobNumber: p.job.jobNumber, date: p.job.completedAt ?? p.job.openedAt,
      ...(pricing ? { sellPriceCents: p.sellPriceCents } : {}),
    }));
  });
}

/** Photos taken on this vehicle's jobs (the Photos tab), newest first. */
export async function listVehiclePhotos(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'vehicle.view');
  requirePermission(ctx, 'job.view');
  const vehicleId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id }, select: { id: true } });
    if (!v) throw Errors.notFound('Vehicle');
    const rows = await tx.jobPhoto.findMany({
      where: { businessId: ctx.business.id, vehicleId, archivedAt: null }, orderBy: { createdAt: 'desc' }, take: 120, include: { job: { select: { jobNumber: true } } },
    });
    return rows.map((p) => ({ id: p.id, fileId: p.fileId, category: p.category, visibility: p.visibility, description: p.description, createdAt: p.createdAt, jobId: p.jobId, jobNumber: p.job.jobNumber }));
  });
}
