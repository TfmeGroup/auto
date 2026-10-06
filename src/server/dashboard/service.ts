import { withTenant, seq } from '@/server/db/client';
import { can } from '@/server/permissions/authorize';
import { prisma } from '@/server/db/client';
import { dayRange, todayIso } from '@/lib/tz';
import { locationWhere, memberNames, visibleLocationIds } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';

/** Real counts from the database, limited to what the caller is allowed to see. Nothing here is a stored or hard-coded statistic. */
export async function getDashboard(ctx: BusinessContext) {
  const businessId = ctx.business.id;
  const { start, end } = dayRange(todayIso(ctx.business.timezone), ctx.business.timezone);

  const ops = await withTenant(businessId, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const seeJobs = can(ctx, 'job.view');
    const seeBookings = can(ctx, 'booking.view');
    const openJobs = { businessId, ...locationWhere(scope), status: { notIn: ['COMPLETED', 'CANCELLED'] as ('COMPLETED' | 'CANCELLED')[] } };

    const byStatus = seeJobs ? await tx.jobCard.groupBy({ by: ['status'], where: openJobs, _count: true }) : null;
    const counts = byStatus ? Object.fromEntries(byStatus.map((s) => [s.status, s._count])) as Record<string, number> : null;
    const [mine, unassigned, todayBookings, todayList] = await seq([
      seeJobs ? tx.jobCard.count({ where: { ...openJobs, status: { notIn: ['COMPLETED', 'CANCELLED', 'BOOKED'] }, OR: [{ primaryTechnicianMembershipId: ctx.membership.id }, { technicians: { some: { membershipId: ctx.membership.id } } }] } }) : null,
      seeJobs ? tx.jobCard.count({ where: { ...openJobs, status: { notIn: ['COMPLETED', 'CANCELLED', 'BOOKED'] }, primaryTechnicianMembershipId: null } }) : null,
      seeBookings ? tx.booking.count({ where: { businessId, ...locationWhere(scope), startsAt: { gte: start, lt: end }, status: { notIn: ['CANCELLED', 'NO_SHOW'] } } }) : null,
      seeBookings
        ? tx.booking.findMany({
            where: { businessId, ...locationWhere(scope), startsAt: { gte: start, lt: end }, status: { notIn: ['CANCELLED', 'NO_SHOW'] } },
            orderBy: { startsAt: 'asc' }, take: 8,
            include: { customer: { select: { name: true } }, vehicle: { select: { registration: true, model: true } } },
          })
        : null,
    ]);
    const techNames = todayList ? await memberNames(tx, businessId, todayList.map((b) => b.technicianMembershipId)) : new Map<string, string>();
    return {
      jobCounts: counts,
      activeJobs: counts ? Object.entries(counts).filter(([s]) => s !== 'BOOKED').reduce((n, [, c]) => n + c, 0) : null,
      awaitingApproval: counts ? (counts.AWAITING_APPROVAL ?? 0) : null,
      readyForCollection: counts ? (counts.READY_FOR_COLLECTION ?? 0) : null,
      awaitingParts: counts ? (counts.AWAITING_PARTS ?? 0) : null,
      mine, unassigned, todayBookings,
      todayList: todayList?.map((b) => ({ id: b.id, startsAt: b.startsAt, serviceLabel: b.serviceLabel, status: b.status, customer: b.customer.name, vehicle: [b.vehicle.registration, b.vehicle.model].filter(Boolean).join(' '), technician: b.technicianMembershipId ? (techNames.get(b.technicianMembershipId) ?? null) : null })) ?? null,
    };
  });

  const [counts, members, recent] = await Promise.all([
    can(ctx, 'customer.view') || can(ctx, 'vehicle.view')
      ? withTenant(businessId, async (tx) => ({
          customers: can(ctx, 'customer.view') ? await tx.customer.count({ where: { businessId, status: 'ACTIVE' } }) : null,
          vehicles: can(ctx, 'vehicle.view') ? await tx.vehicle.count({ where: { businessId, archivedAt: null } }) : null,
          files: can(ctx, 'document.view') ? await tx.file.count({ where: { businessId, status: 'ACTIVE' } }) : null,
        }))
      : Promise.resolve({ customers: null, vehicles: null, files: null }),
    can(ctx, 'employee.view') ? prisma().membership.count({ where: { businessId, status: 'ACTIVE' } }) : Promise.resolve(null),
    can(ctx, 'audit.view')
      ? withTenant(businessId, (tx) => tx.auditLog.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 6 }))
      : Promise.resolve(null),
  ]);
  return { customers: counts.customers, vehicles: counts.vehicles, files: counts.files, members, recent, ops };
}
