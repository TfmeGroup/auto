import { z } from 'zod';
import { Prisma, prisma, withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { escapeLike, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite, countSeats } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { isPermission, permissionGroups, PERMISSIONS } from '@/server/permissions/catalog';
import { notifyStaff } from '@/server/finance/notify';
import { systemMeta, type BusinessContext } from '@/server/context';

/**
 * The team directory. People are accounts with a membership in this business; nothing here creates a login. Only what the business is
 * entitled to see about a person is shown: name, work email, mobile, role, locations, status, when they joined and were last active.
 * No security details (MFA, sign-in addresses, devices) ever appear.
 */

export const employeeListSchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  roleId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  technician: z.enum(['1', '0']).optional(),
});

export async function listEmployees(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'employee.view');
  const q = parseOrThrow(employeeListSchema, query);
  const bid = ctx.business.id;
  return withTenant(bid, async (tx) => {
    const conds: Prisma.Sql[] = [Prisma.sql`m.business_id = ${bid}::uuid`];
    conds.push(q.status ? Prisma.sql`m.status = ${q.status}::membership_status` : Prisma.sql`m.status <> 'ARCHIVED'`);
    if (q.roleId) conds.push(Prisma.sql`m.role_id = ${q.roleId}::uuid`);
    if (q.locationId) conds.push(Prisma.sql`(m.all_locations OR EXISTS (SELECT 1 FROM membership_locations ml WHERE ml.membership_id = m.id AND ml.location_id = ${q.locationId}::uuid))`);
    for (const w of (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 4)) {
      const like = `%${escapeLike(w)}%`;
      conds.push(Prisma.sql`(u.name ILIKE ${like} OR u.email ILIKE ${like} OR m.invited_email ILIKE ${like})`);
    }
    const isTech = Prisma.sql`COALESCE(tp.is_technician AND tp.status = 'ACTIVE', EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = m.role_id AND rp.permission = 'job.edit'))`;
    if (q.technician) conds.push(q.technician === '1' ? Prisma.sql`${isTech}` : Prisma.sql`NOT ${isTech}`);
    const rows = await tx.$queryRaw<{ id: string; total: bigint; is_tech: boolean }[]>`
      SELECT m.id, count(*) OVER() AS total, ${isTech} AS is_tech
        FROM memberships m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN technician_profiles tp ON tp.membership_id = m.id
       WHERE ${Prisma.join(conds, ' AND ')}
       ORDER BY CASE m.status WHEN 'ACTIVE' THEN 0 WHEN 'INVITED' THEN 1 WHEN 'SUSPENDED' THEN 2 ELSE 3 END, lower(COALESCE(u.name, m.invited_email)), m.id
       LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const total = rows.length ? Number(rows[0]!.total) : 0;
    const ids = rows.map((r) => r.id);
    const members = await tx.membership.findMany({
      where: { id: { in: ids }, businessId: bid },
      include: { user: { select: { id: true, name: true, email: true, mobile: true } }, role: { select: { id: true, name: true } }, locations: { include: { location: { select: { name: true } } } } },
    });
    const byId = new Map(members.map((m) => [m.id, m]));
    const userIds = members.map((m) => m.userId).filter((v): v is string => !!v);
    const sessions = userIds.length ? await tx.$queryRaw<{ user_id: string; last: Date }[]>`SELECT user_id, max(last_used_at) AS last FROM sessions WHERE user_id = ANY(${userIds}::uuid[]) GROUP BY user_id` : [];
    const last = new Map(sessions.map((s) => [s.user_id, s.last]));
    const tech = new Map(rows.map((r) => [r.id, r.is_tech]));
    const now = Date.now();
    return {
      items: ids.flatMap((id) => {
        const m = byId.get(id);
        if (!m) return [];
        return [{
          id: m.id, name: m.user?.name ?? null, email: m.user?.email ?? m.invitedEmail, phone: m.user?.mobile ?? null, role: m.role, status: m.status, isOwner: m.isOwner, isTechnician: tech.get(id) ?? false,
          locations: m.allLocations ? 'All locations' : m.locations.map((l) => l.location.name).join(', ') || 'No locations', joinedAt: m.joinedAt, invitedAt: m.invitedAt,
          inviteExpiresAt: m.inviteExpiresAt, inviteExpired: m.status === 'INVITED' && !!m.inviteExpiresAt && m.inviteExpiresAt.getTime() < now, lastActiveAt: m.userId ? (last.get(m.userId) ?? null) : null,
        }];
      }),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

/** How many seats the plan allows and how many are used, so the page can say so (and warn when a downgrade left the business over its limit). */
export async function getSeatUsage(ctx: BusinessContext) {
  requirePermission(ctx, 'employee.view');
  return withTenant(ctx.business.id, async (tx) => {
    const used = await countSeats(tx, ctx.business.id);
    const limit = ctx.subscription.limits.members;
    return { used, limit, over: used > limit, plan: ctx.subscription.planName };
  });
}

export async function getEmployee(ctx: BusinessContext, membershipId: string) {
  requirePermission(ctx, 'employee.view');
  parseOrThrow(uuidSchema, membershipId);
  return withTenant(ctx.business.id, async (tx) => {
    const m = await tx.membership.findFirst({
      where: { id: membershipId, businessId: ctx.business.id },
      include: { user: { select: { id: true, name: true, email: true, mobile: true } }, role: { select: { id: true, name: true, key: true, description: true } }, locations: { include: { location: { select: { id: true, name: true } } } } },
    });
    if (!m) throw Errors.notFound('Team member');
    const perms = (await tx.rolePermission.findMany({ where: { roleId: m.roleId } })).map((p) => p.permission).filter(isPermission);
    const groups = permissionGroups();
    const summary = Object.entries(groups).map(([area, all]) => ({ area, granted: all.filter((p) => perms.includes(p)).map((p) => PERMISSIONS[p]), total: all.length })).filter((g) => g.granted.length > 0);
    const lastSession = m.userId ? await tx.$queryRaw<{ last: Date | null }[]>`SELECT max(last_used_at) AS last FROM sessions WHERE user_id = ${m.userId}::uuid` : [];
    const onJob = { OR: [{ primaryTechnicianMembershipId: membershipId }, { technicians: { some: { membershipId } } }] };
    const openJobs = await tx.jobCard.findMany({ where: { businessId: ctx.business.id, status: { notIn: ['COMPLETED', 'CANCELLED'] }, ...onJob }, orderBy: { openedAt: 'desc' }, take: 25, select: { id: true, jobNumber: true, status: true, vehicle: { select: { registration: true, make: true, model: true } } } });
    const completed = await tx.jobCard.count({ where: { businessId: ctx.business.id, status: 'COMPLETED', ...onJob } });
    const activity = await tx.auditLog.findMany({ where: { businessId: ctx.business.id, resourceType: 'membership', resourceId: membershipId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, action: true, createdAt: true, userId: true, metadata: true } });
    const actors = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(activity.map((a) => a.userId).filter((v): v is string => !!v))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const tp = await tx.technicianProfile.findFirst({ where: { businessId: ctx.business.id, membershipId }, select: { isTechnician: true, status: true } });
    const hasJobEdit = perms.includes('job.edit');
    return {
      id: m.id, status: m.status, isOwner: m.isOwner, name: m.user?.name ?? null, email: m.user?.email ?? m.invitedEmail, phone: m.user?.mobile ?? null, role: m.role, joinedAt: m.joinedAt, invitedAt: m.invitedAt, inviteExpiresAt: m.inviteExpiresAt,
      allLocations: m.allLocations, locations: m.locations.map((l) => l.location), lastActiveAt: lastSession[0]?.last ?? null, permissionSummary: summary,
      isTechnician: tp ? tp.isTechnician && tp.status === 'ACTIVE' : hasJobEdit, openJobs, completedJobs: completed,
      history: activity.map((a) => ({ id: a.id, action: a.action, at: a.createdAt, by: a.userId ? (actors.get(a.userId) ?? null) : null, reason: (a.metadata as { reason?: string } | null)?.reason ?? null })),
      can: { edit: can(ctx, 'employee.edit'), suspend: can(ctx, 'employee.suspend') && m.id !== ctx.membership.id && !m.isOwner, manageRoles: can(ctx, 'employee.manage_roles') && !m.isOwner, manageTechnician: can(ctx, 'employee.manage_technicians') },
    };
  });
}

// ───────── Locations ─────────

export const memberLocationsSchema = z.object({ allLocations: z.boolean(), locationIds: z.array(uuidSchema).max(50).default([]) });

/** Change where someone may work. Needs more than one location on the plan, and the person ends up with at least one (or all). */
export async function setMemberLocations(ctx: BusinessContext, membershipId: string, input: unknown) {
  requirePermission(ctx, 'employee.edit');
  requireFeature(ctx.subscription, 'multi_location');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, membershipId);
  const d = parseOrThrow(memberLocationsSchema, input);
  if (!d.allLocations && d.locationIds.length === 0) throw Errors.validation({ locationIds: 'Choose at least one location, or allow all of them.' });
  return withTenant(ctx.business.id, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: membershipId, businessId: ctx.business.id }, include: { locations: true } });
    if (!m) throw Errors.notFound('Team member');
    if (m.isOwner && !d.allLocations) throw Errors.conflict('The Owner always has access to every location.');
    if (!d.allLocations) {
      const found = await tx.location.count({ where: { businessId: ctx.business.id, status: 'ACTIVE', id: { in: d.locationIds } } });
      if (found !== new Set(d.locationIds).size) throw Errors.validation({ locationIds: 'Choose locations of this business.' });
    }
    await tx.membershipLocation.deleteMany({ where: { membershipId } });
    if (!d.allLocations) await tx.membershipLocation.createMany({ data: [...new Set(d.locationIds)].map((locationId) => ({ membershipId, locationId })) });
    await tx.membership.update({ where: { id: membershipId }, data: { allLocations: d.allLocations } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.memberLocationsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: membershipId, before: { allLocations: m.allLocations, locationIds: m.locations.map((l) => l.locationId) }, after: { allLocations: d.allLocations, locationIds: d.allLocations ? [] : d.locationIds } });
    return { allLocations: d.allLocations, locationIds: d.locationIds };
  });
}

// ───────── Invitation expiry (scheduled) ─────────

/**
 * Invitations stop working when they expire. This marks the expired ones so the team page does not show them as pending, and tells whoever
 * sent each one. Safe to run twice and from many workers: it only touches rows still pending and past their expiry.
 */
export async function expireInvitations(now = new Date()): Promise<number> {
  const stale = await prisma().membership.findMany({ where: { status: 'INVITED', userId: null, inviteExpiresAt: { lt: now } }, select: { id: true, businessId: true, invitedEmail: true, invitedById: true }, take: 500 });
  let n = 0;
  for (const m of stale) {
    const done = await withTenant(m.businessId, async (tx) => {
      const claimed = await tx.membership.updateMany({ where: { id: m.id, businessId: m.businessId, status: 'INVITED', userId: null, inviteExpiresAt: { lt: now } }, data: { status: 'ARCHIVED', inviteTokenHash: null, inviteExpiresAt: null } });
      if (claimed.count !== 1) return false;
      await recordAudit(tx, systemMeta('scheduler'), { action: AuditActions.memberInviteRevoked, businessId: m.businessId, userId: null, resourceType: 'membership', resourceId: m.id, metadata: { email: m.invitedEmail, reason: 'expired' } });
      if (m.invitedById) await notifyStaff(tx, m.businessId, [m.invitedById], { type: 'INVITATION_EXPIRED', title: `The invitation to ${m.invitedEmail} expired`, body: 'They did not accept it in time. Invite them again if they still need access.', linkUrl: '/team' });
      return true;
    });
    if (done) n++;
  }
  return n;
}
