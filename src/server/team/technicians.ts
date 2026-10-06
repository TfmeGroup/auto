import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { notifyStaff, usersWithPermission } from '@/server/finance/notify';
import { isOpen, type JobStatus } from '@/server/jobcards/transitions';
import type { BusinessContext } from '@/server/context';

/**
 * Technician settings. A person is a technician when a profile says so; without a profile the original rule applies (their role
 * may edit jobs). Deactivating a technician stops NEW work being assigned to them; jobs and bookings they already have are never
 * silently moved or deleted, and the people who run the schedule are told what is affected.
 */

const skill = z.string().trim().min(1).max(40);

export const technicianSchema = z.object({
  isTechnician: z.boolean(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  billableRateCentsPerHour: z.union([z.null(), z.literal(''), z.coerce.number().int().min(0).max(10_000_000)]).transform((v) => (v === '' ? null : v)),
  labourCostCentsPerHour: z.union([z.null(), z.literal(''), z.coerce.number().int().min(0).max(10_000_000)]).transform((v) => (v === '' ? null : v)),
  skills: z.array(skill).max(30),
  serviceTypeIds: z.array(uuidSchema).max(100),
  notes: z.string().trim().max(1000).nullish().transform((v) => (v ? v : null)),
}).partial();

async function loadMember(tx: Tx, businessId: string, membershipId: string) {
  const m = await tx.membership.findFirst({ where: { id: membershipId, businessId }, include: { user: { select: { name: true, email: true } }, role: { select: { name: true, key: true } } } });
  if (!m) throw Errors.notFound('Team member');
  return m;
}

/** Everything about one technician that the caller is allowed to see. */
export async function getTechnician(ctx: BusinessContext, membershipId: string) {
  requirePermission(ctx, 'employee.view');
  parseOrThrow(uuidSchema, membershipId);
  const rates = can(ctx, 'labour.view_rates');
  const costs = can(ctx, 'labour.view_costs');
  return withTenant(ctx.business.id, async (tx) => {
    const m = await loadMember(tx, ctx.business.id, membershipId);
    const tp = await tx.technicianProfile.findFirst({ where: { businessId: ctx.business.id, membershipId }, include: { serviceTypes: true } });
    const hasJobEdit = !!(await tx.rolePermission.findFirst({ where: { roleId: m.roleId, permission: 'job.edit' } }));
    const isTechnician = tp ? tp.isTechnician : hasJobEdit;
    const now = new Date();
    const schedule = await tx.technicianSchedule.findMany({ where: { businessId: ctx.business.id, membershipId }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] });
    const timeOff = await tx.technicianTimeOff.findMany({ where: { businessId: ctx.business.id, membershipId, endsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, take: 20 });
    const jobWhere = { businessId: ctx.business.id, OR: [{ primaryTechnicianMembershipId: membershipId }, { technicians: { some: { membershipId } } }] };
    const open = await tx.jobCard.findMany({ where: { ...jobWhere, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, orderBy: { openedAt: 'desc' }, take: 50, select: { id: true, jobNumber: true, status: true, openedAt: true, vehicle: { select: { registration: true, make: true, model: true } } } });
    const since = new Date(now.getTime() - 90 * 86_400_000);
    const completed90 = await tx.jobCard.count({ where: { ...jobWhere, status: 'COMPLETED', completedAt: { gte: since } } });
    const completedAll = await tx.jobCard.count({ where: { ...jobWhere, status: 'COMPLETED' } });
    const bookings = await tx.booking.findMany({ where: { businessId: ctx.business.id, technicianMembershipId: membershipId, startsAt: { gte: now }, status: { in: ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT'] } }, orderBy: { startsAt: 'asc' }, take: 20, select: { id: true, bookingNumber: true, startsAt: true, endsAt: true, serviceLabel: true } });
    const services = await tx.serviceType.findMany({ where: { businessId: ctx.business.id, id: { in: tp?.serviceTypes.map((s) => s.serviceTypeId) ?? [] } }, select: { id: true, name: true } });
    const running = await tx.timeEntry.findFirst({ where: { businessId: ctx.business.id, membershipId, status: 'RUNNING' }, select: { id: true, jobId: true, startedAt: true } });
    return {
      member: { id: m.id, name: m.user?.name ?? m.invitedEmail ?? 'Invited', email: m.user?.email ?? m.invitedEmail, role: m.role.name, status: m.status },
      isTechnician,
      hasProfile: !!tp,
      status: tp?.status ?? 'ACTIVE',
      deactivatedAt: tp?.deactivatedAt ?? null,
      skills: tp?.skills ?? [],
      serviceTypes: services,
      notes: tp?.notes ?? null,
      billableRateCentsPerHour: rates ? (tp?.billableRateCentsPerHour ?? null) : null,
      labourCostCentsPerHour: costs ? m.labourCostCentsPerHour : null,
      schedule: schedule.map((s) => ({ weekday: s.weekday, startMinute: s.startMinute, endMinute: s.endMinute })),
      usesWorkshopHours: schedule.length === 0,
      timeOff: timeOff.map((t) => ({ id: t.id, kind: t.kind, startsAt: t.startsAt, endsAt: t.endsAt, reason: t.reason })),
      openJobs: open.filter((j) => isOpen(j.status as JobStatus)),
      completedLast90Days: completed90,
      completedTotal: completedAll,
      upcomingBookings: bookings,
      runningTimer: running,
      canManage: can(ctx, 'employee.manage_technicians'),
      canManageRates: can(ctx, 'labour.manage_rates'),
    };
  });
}

/** Create or change a technician's settings. Billable and cost rates need the labour-rate permission; changes are audited with before and after. */
export async function setTechnician(ctx: BusinessContext, membershipId: string, input: unknown) {
  requirePermission(ctx, 'employee.manage_technicians');
  requireFeature(ctx.subscription, 'technician_management');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, membershipId);
  const d = parseOrThrow(technicianSchema, input);
  if ((d.billableRateCentsPerHour !== undefined || d.labourCostCentsPerHour !== undefined) && !can(ctx, 'labour.manage_rates')) throw Errors.forbidden('You do not have permission to change labour rates.');
  return withTenant(ctx.business.id, async (tx) => {
    const m = await loadMember(tx, ctx.business.id, membershipId);
    if (m.status !== 'ACTIVE') throw Errors.conflict('Only active team members can be set up as technicians.');
    const hasJobEdit = !!(await tx.rolePermission.findFirst({ where: { roleId: m.roleId, permission: 'job.edit' } }));
    const before = await tx.technicianProfile.findFirst({ where: { businessId: ctx.business.id, membershipId }, include: { serviceTypes: true } });
    const wasTech = before ? before.isTechnician && before.status === 'ACTIVE' : hasJobEdit;
    const next = {
      isTechnician: d.isTechnician ?? before?.isTechnician ?? true,
      status: d.status ?? before?.status ?? 'ACTIVE',
      skills: d.skills ?? before?.skills ?? [],
      notes: d.notes !== undefined ? d.notes : (before?.notes ?? null),
      billableRateCentsPerHour: d.billableRateCentsPerHour !== undefined ? d.billableRateCentsPerHour : (before?.billableRateCentsPerHour ?? null),
    };
    if (d.serviceTypeIds) {
      const found = await tx.serviceType.count({ where: { businessId: ctx.business.id, id: { in: d.serviceTypeIds } } });
      if (found !== new Set(d.serviceTypeIds).size) throw Errors.validation({ serviceTypeIds: 'Choose service types of this business.' });
    }
    const wantsInactive = next.status === 'INACTIVE' || !next.isTechnician;
    const profile = await tx.technicianProfile.upsert({
      where: { membershipId },
      create: { businessId: ctx.business.id, membershipId, ...next, deactivatedAt: wantsInactive ? new Date() : null, updatedById: ctx.user.id },
      update: { ...next, deactivatedAt: wantsInactive ? (before?.deactivatedAt ?? new Date()) : null, updatedById: ctx.user.id },
    });
    if (d.serviceTypeIds) {
      await tx.technicianServiceType.deleteMany({ where: { technicianId: profile.id } });
      if (d.serviceTypeIds.length) await tx.technicianServiceType.createMany({ data: [...new Set(d.serviceTypeIds)].map((serviceTypeId) => ({ technicianId: profile.id, serviceTypeId, businessId: ctx.business.id })) });
    }
    if (d.labourCostCentsPerHour !== undefined && d.labourCostCentsPerHour !== m.labourCostCentsPerHour) {
      await tx.membership.update({ where: { id: membershipId }, data: { labourCostCentsPerHour: d.labourCostCentsPerHour } });
      await recordAudit(tx, ctx.meta, { action: AuditActions.labourCostRateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: membershipId, before: { labourCostCentsPerHour: m.labourCostCentsPerHour }, after: { labourCostCentsPerHour: d.labourCostCentsPerHour } });
    }
    if (d.billableRateCentsPerHour !== undefined && next.billableRateCentsPerHour !== (before?.billableRateCentsPerHour ?? null)) {
      await recordAudit(tx, ctx.meta, { action: AuditActions.labourRateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: membershipId, before: { rateCentsPerHour: before?.billableRateCentsPerHour ?? null }, after: { rateCentsPerHour: next.billableRateCentsPerHour }, metadata: { scope: 'technician', name: m.user?.name } });
    }
    const isTechNow = next.isTechnician && next.status === 'ACTIVE';
    await recordAudit(tx, ctx.meta, {
      action: wasTech && !isTechNow ? AuditActions.technicianDeactivated : !wasTech && isTechNow && before ? AuditActions.technicianReactivated : AuditActions.technicianSettingsChanged,
      businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: membershipId,
      before: before ? { isTechnician: before.isTechnician, status: before.status, skills: before.skills } : { isTechnician: hasJobEdit }, after: { isTechnician: next.isTechnician, status: next.status, skills: next.skills }, metadata: { name: m.user?.name },
    });

    // Warn the people who run the schedule about work this technician already holds.
    const affected = { openJobs: 0, upcomingBookings: 0 };
    if (wasTech && !isTechNow) {
      affected.openJobs = await tx.jobCard.count({ where: { businessId: ctx.business.id, status: { notIn: ['COMPLETED', 'CANCELLED'] }, OR: [{ primaryTechnicianMembershipId: membershipId }, { technicians: { some: { membershipId } } }] } });
      affected.upcomingBookings = await tx.booking.count({ where: { businessId: ctx.business.id, technicianMembershipId: membershipId, startsAt: { gte: new Date() }, status: { in: ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT'] } } });
      if (affected.openJobs + affected.upcomingBookings > 0) {
        const planners = await usersWithPermission(tx, ctx.business.id, 'job.assign');
        await notifyStaff(tx, ctx.business.id, planners.map((p) => p.id).filter((id) => id !== ctx.user.id), {
          type: 'TECHNICIAN_DEACTIVATED', title: `${m.user?.name ?? 'A technician'} can no longer be assigned work`,
          body: `${affected.openJobs} open job${affected.openJobs === 1 ? '' : 's'} and ${affected.upcomingBookings} upcoming booking${affected.upcomingBookings === 1 ? '' : 's'} are still assigned to them. Nothing was moved; reassign what you need to.`, linkUrl: `/team/${membershipId}`,
        });
      }
    }
    return { membershipId, isTechnician: next.isTechnician, status: next.status, affected };
  });
}

/** What a technician sees first on their phone: today's appointments and where each of their open jobs stands for parts. */
export async function getMyDay(ctx: BusinessContext) {
  requirePermission(ctx, 'job.view');
  return withTenant(ctx.business.id, async (tx) => {
    const tz = ctx.business.timezone;
    const { dayRange, todayIso } = await import('@/lib/tz');
    const day = dayRange(todayIso(tz), tz);
    const bookings = await tx.booking.findMany({
      where: { businessId: ctx.business.id, technicianMembershipId: ctx.membership.id, startsAt: { gte: day.start, lt: day.end }, status: { notIn: ['CANCELLED', 'NO_SHOW', 'RESCHEDULED'] } },
      orderBy: { startsAt: 'asc' }, select: { id: true, bookingNumber: true, startsAt: true, endsAt: true, serviceLabel: true, status: true, vehicle: { select: { registration: true, make: true, model: true } } },
    });
    const off = await tx.technicianTimeOff.findFirst({ where: { businessId: ctx.business.id, membershipId: ctx.membership.id, startsAt: { lt: day.end }, endsAt: { gt: day.start } }, select: { kind: true, reason: true } });
    const jobIds = (await tx.jobCard.findMany({ where: { businessId: ctx.business.id, status: { notIn: ['COMPLETED', 'CANCELLED'] }, OR: [{ primaryTechnicianMembershipId: ctx.membership.id }, { technicians: { some: { membershipId: ctx.membership.id } } }] }, select: { id: true } })).map((j) => j.id);
    const parts = jobIds.length ? await tx.jobPart.groupBy({ by: ['jobId', 'status'], where: { businessId: ctx.business.id, jobId: { in: jobIds }, archivedAt: null }, _sum: { quantity: true } }) : [];
    const byJob: Record<string, { reserved: number; fitted: number; waiting: number }> = {};
    for (const p of parts) {
      const row = (byJob[p.jobId] ??= { reserved: 0, fitted: 0, waiting: 0 });
      const q = p._sum.quantity ?? 0;
      if (p.status === 'RESERVED') row.reserved += q;
      else if (p.status === 'FITTED') row.fitted += q;
      else if (p.status === 'REQUESTED' || p.status === 'ORDERED') row.waiting += q;
    }
    return { bookings, off, partsByJob: byJob };
  });
}
