import { z } from 'zod';
import { prisma, withTx, withTenant, setTenant, type Db, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { appUrl } from '@/lib/url';
import { emailSchema, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { generateToken, hashToken } from '@/server/security/crypto';
import { consumeAll } from '@/server/security/rate-limit';
import { emailUser, queueEmail } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { assertCanWrite, assertWithinLimit } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import { isPermission, OWNER_ROLE_KEY, SYSTEM_ROLES, type Permission } from '@/server/permissions/catalog';
import { setActiveBusiness } from '@/server/auth/session';
import type { BusinessContext, UserContext } from '@/server/context';

const INVITE_TTL_MS = 7 * 86_400_000;

export const inviteSchema = z.object({
  email: emailSchema,
  roleId: uuidSchema,
  /** Optional: restrict the person to specific locations (needs a plan with multiple locations). */
  locationIds: z.array(uuidSchema).max(50).optional(),
});
export const changeRoleSchema = z.object({ roleId: uuidSchema, reason: z.string().trim().max(300).optional() });
export const memberListSchema = paginationSchema.extend({
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
});

// ─────────────── Roles & privilege-escalation guard ───────────────

export async function rolePermissions(db: Db, roleId: string): Promise<Set<Permission>> {
  const rows = await db.rolePermission.findMany({ where: { roleId } });
  return new Set(rows.map((r) => r.permission).filter(isPermission));
}

const rank = (key: string) => {
  const i = SYSTEM_ROLES.findIndex((r) => r.key === key);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

/**
 * Roles this person may assign. Never the Owner role (ownership is transferred, not granted),
 * never archived roles, and only roles whose permissions they hold themselves.
 */
export async function listAssignableRoles(ctx: BusinessContext) {
  requirePermission(ctx, 'employee.view');
  const roles = await prisma().role.findMany({
    where: { archivedAt: null, OR: [{ businessId: null }, { businessId: ctx.business.id }] },
    include: { permissions: true },
  });
  roles.sort((a, b) => (a.isSystem === b.isSystem ? (a.isSystem ? rank(a.key) - rank(b.key) : a.name.localeCompare(b.name)) : a.isSystem ? -1 : 1));
  return roles
    .filter((r) => !(r.isSystem && r.key === OWNER_ROLE_KEY))
    .filter((r) => r.permissions.every((p) => !isPermission(p.permission) || ctx.permissions.has(p.permission)))
    .map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem }));
}

/**
 * Nobody can grant permissions they do not hold, and Owner is never granted: it moves only through
 * the deliberate, re-authenticated ownership transfer.
 */
async function assertCanGrantRole(tx: Tx, ctx: BusinessContext, roleId: string): Promise<{ id: string; key: string; name: string }> {
  const role = await tx.role.findFirst({ where: { id: roleId, archivedAt: null, OR: [{ businessId: null }, { businessId: ctx.business.id }] } });
  if (!role) throw Errors.validation({ roleId: 'Unknown role.' });
  if (role.isSystem && role.key === OWNER_ROLE_KEY) throw Errors.forbidden('Ownership is transferred, not granted. Use "Transfer ownership" in business security settings.');
  for (const p of await rolePermissions(tx, role.id)) {
    if (!ctx.permissions.has(p)) throw Errors.forbidden('You cannot grant a role with more access than your own.');
  }
  return role;
}

/** Likewise, nobody can modify a member who holds permissions they lack. */
async function assertCanManageTarget(tx: Tx, ctx: BusinessContext, targetRoleId: string): Promise<void> {
  for (const p of await rolePermissions(tx, targetRoleId)) {
    if (!ctx.permissions.has(p)) throw Errors.forbidden('You cannot manage a member with more access than your own.');
  }
}

async function loadMemberInBusiness(tx: Tx, businessId: string, membershipId: string) {
  // Explicit business filter: memberships are control-plane data without row-level security.
  const m = await tx.membership.findFirst({ where: { id: membershipId, businessId }, include: { role: true, user: true } });
  if (!m) throw Errors.notFound('Member');
  return m;
}

// ─────────────── Listing ───────────────

export async function listMembers(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'employee.view');
  const q = parseOrThrow(memberListSchema, query);
  const where = { businessId: ctx.business.id, ...(q.status ? { status: q.status } : {}) };
  const [total, rows] = await Promise.all([
    prisma().membership.count({ where }),
    prisma().membership.findMany({
      where,
      include: {
        user: { select: { name: true, email: true } },
        role: { select: { id: true, name: true, key: true } },
        locations: { include: { location: { select: { name: true } } } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  return {
    items: rows.map((m) => ({
      id: m.id,
      status: m.status,
      isOwner: m.isOwner,
      name: m.user?.name ?? null,
      email: m.user?.email ?? m.invitedEmail,
      role: m.role,
      joinedAt: m.joinedAt,
      inviteExpiresAt: m.inviteExpiresAt,
      locations: m.allLocations ? 'All locations' : m.locations.map((l) => l.location.name).join(', ') || 'No locations',
    })),
    meta: pageMeta(q.page, q.pageSize, total),
  };
}

// ─────────────── Invitations ───────────────

async function resolveLocations(tx: Tx, ctx: BusinessContext, ids: string[] | undefined) {
  if (!ids || ids.length === 0) return null;
  requireFeature(ctx.subscription, 'multi_location');
  const unique = [...new Set(ids)];
  const found = await tx.location.findMany({ where: { id: { in: unique }, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } });
  if (found.length !== unique.length) throw Errors.validation({ locationIds: 'One or more locations do not exist.' });
  return unique;
}

export async function inviteMember(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'employee.invite');
  assertCanWrite(ctx.subscription);
  const data = parseOrThrow(inviteSchema, input);
  await consumeAll([
    { key: `invite:business:${ctx.business.id}`, limit: 30, windowSec: 3600 },
    { key: `invite:user:${ctx.user.id}`, limit: 20, windowSec: 3600 },
  ]);

  return withTenant(ctx.business.id, async (tx) => {
    const role = await assertCanGrantRole(tx, ctx, data.roleId);
    const locationIds = await resolveLocations(tx, ctx, data.locationIds);

    const existingUser = await tx.user.findUnique({ where: { email: data.email } });
    if (existingUser) {
      const m = await tx.membership.findUnique({ where: { businessId_userId: { businessId: ctx.business.id, userId: existingUser.id } } });
      if (m && (m.status === 'ACTIVE' || m.status === 'SUSPENDED')) throw Errors.conflict('That person is already a member of this business.');
    }

    const token = generateToken();
    const expiryDays = (await tx.businessConfig.findUnique({ where: { businessId: ctx.business.id }, select: { invitationExpiryDays: true } }))?.invitationExpiryDays;
    const expiresAt = new Date(Date.now() + (expiryDays ? expiryDays * 86_400_000 : INVITE_TTL_MS));
    const open = await tx.membership.findFirst({ where: { businessId: ctx.business.id, invitedEmail: data.email, status: 'INVITED', userId: null } });

    let membershipId: string;
    if (open) {
      // Re-invite: rotate the token (old link dies) and refresh role/expiry. No new seat used.
      await tx.membership.update({
        where: { id: open.id },
        data: { roleId: role.id, inviteTokenHash: hashToken(token), inviteExpiresAt: expiresAt, invitedById: ctx.user.id, invitedAt: new Date(), allLocations: !locationIds },
      });
      await tx.membershipLocation.deleteMany({ where: { membershipId: open.id } });
      membershipId = open.id;
    } else {
      await assertWithinLimit(tx, ctx.business.id, ctx.subscription, 'members');
      const m = await tx.membership.create({
        data: {
          businessId: ctx.business.id,
          roleId: role.id,
          status: 'INVITED',
          invitedEmail: data.email,
          inviteTokenHash: hashToken(token),
          inviteExpiresAt: expiresAt,
          invitedById: ctx.user.id,
          invitedAt: new Date(),
          allLocations: !locationIds,
        },
      });
      membershipId = m.id;
    }
    if (locationIds) await tx.membershipLocation.createMany({ data: locationIds.map((locationId) => ({ membershipId, locationId })) });

    await queueEmail(tx, templates.invitation(data.email, ctx.business.name, ctx.user.name, role.name, appUrl(`/accept-invite?token=${token}`)), { businessId: ctx.business.id });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.memberInvited,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'membership',
      resourceId: membershipId,
      metadata: { email: data.email, roleKey: role.key, locations: locationIds?.length ?? 'all' },
    });
    return { id: membershipId, email: data.email, role: { id: role.id, name: role.name } };
  });
}

/** Send the invitation again with a fresh link (the old link stops working). Rate-limited. */
export async function resendInvitation(ctx: BusinessContext, membershipId: string) {
  requirePermission(ctx, 'employee.invite');
  assertCanWrite(ctx.subscription);
  await consumeAll([
    { key: `invite-resend:membership:${membershipId}`, limit: 3, windowSec: 3600 },
    { key: `invite:business:${ctx.business.id}`, limit: 30, windowSec: 3600 },
  ]);
  return withTenant(ctx.business.id, async (tx) => {
    const m = await loadMemberInBusiness(tx, ctx.business.id, membershipId);
    if (m.status !== 'INVITED' || m.userId || !m.invitedEmail) throw Errors.conflict('This invitation can no longer be resent.');
    await assertCanManageTarget(tx, ctx, m.roleId);
    const token = generateToken();
    await tx.membership.update({ where: { id: m.id }, data: { inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedById: ctx.user.id, invitedAt: new Date() } });
    await queueEmail(tx, templates.invitation(m.invitedEmail, ctx.business.name, ctx.user.name, m.role.name, appUrl(`/accept-invite?token=${token}`)), { businessId: ctx.business.id });
    await recordAudit(tx, ctx.meta, { action: AuditActions.memberInviteResent, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: m.id, metadata: { email: m.invitedEmail } });
  });
}

export async function revokeInvitation(ctx: BusinessContext, membershipId: string) {
  requirePermission(ctx, 'employee.invite');
  return withTenant(ctx.business.id, async (tx) => {
    const m = await loadMemberInBusiness(tx, ctx.business.id, membershipId);
    if (m.status !== 'INVITED' || m.userId) throw Errors.conflict('This invitation can no longer be revoked.');
    await tx.membership.update({ where: { id: m.id }, data: { status: 'ARCHIVED', inviteTokenHash: null, inviteExpiresAt: null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.memberInviteRevoked, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: m.id, metadata: { email: m.invitedEmail } });
  });
}

/**
 * Accept an invitation. Requirements: signed in, email verified, and the signed-in account's
 * email equals the invited address — a leaked link alone is not enough to join.
 */
export async function acceptInvitation(ctx: UserContext, token: string) {
  if (!ctx.user.emailVerified) throw Errors.emailNotVerified();
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw Errors.badRequest('Invalid invitation link.');

  const invite = await prisma().membership.findUnique({ where: { inviteTokenHash: hashToken(token) } });
  const invalid = () => Errors.badRequest('This invitation is invalid, expired, or was sent to a different email address.');
  if (!invite || invite.status !== 'INVITED' || invite.userId || !invite.inviteExpiresAt || invite.inviteExpiresAt <= new Date() || invite.invitedEmail !== ctx.user.email) {
    throw invalid();
  }

  return withTx(async (tx) => {
    await setTenant(tx, invite.businessId);
    const business = await tx.business.findUniqueOrThrow({ where: { id: invite.businessId } });
    if (business.status !== 'ACTIVE') throw invalid();

    const existing = await tx.membership.findUnique({ where: { businessId_userId: { businessId: invite.businessId, userId: ctx.user.id } } });
    if (existing && (existing.status === 'ACTIVE' || existing.status === 'SUSPENDED')) throw Errors.conflict('You are already a member of this business.');

    let membershipId: string;
    if (existing) {
      // Re-joining after being removed: reuse the old row, drop the invitation placeholder.
      await tx.membership.update({ where: { id: existing.id }, data: { status: 'ACTIVE', roleId: invite.roleId, joinedAt: new Date(), allLocations: invite.allLocations } });
      await tx.membershipLocation.deleteMany({ where: { membershipId: existing.id } });
      const locs = await tx.membershipLocation.findMany({ where: { membershipId: invite.id } });
      if (locs.length) await tx.membershipLocation.createMany({ data: locs.map((l) => ({ membershipId: existing.id, locationId: l.locationId })) });
      await tx.membership.delete({ where: { id: invite.id } });
      membershipId = existing.id;
    } else {
      // Single-use: claim atomically so a concurrent double-submit can't join twice.
      const claimed = await tx.membership.updateMany({
        where: { id: invite.id, status: 'INVITED', userId: null },
        data: { userId: ctx.user.id, status: 'ACTIVE', joinedAt: new Date(), inviteTokenHash: null, inviteExpiresAt: null },
      });
      if (claimed.count !== 1) throw invalid();
      membershipId = invite.id;
    }

    await setActiveBusiness(tx, ctx.sessionId, invite.businessId);
    await recordAudit(tx, ctx.meta, { action: AuditActions.memberJoined, businessId: invite.businessId, userId: ctx.user.id, resourceType: 'membership', resourceId: membershipId });
    if (invite.invitedById) {
      const inviter = await tx.user.findUnique({ where: { id: invite.invitedById } });
      if (inviter) await emailUser(tx, inviter, 'team_activity', (to, name) => templates.membershipChanged(to, name, business.name, `${ctx.user.name} accepted your invitation and joined ${business.name}.`));
    }
    return { businessId: invite.businessId, businessName: business.name };
  });
}

// ─────────────── Role & status changes ───────────────

export async function changeMemberRole(ctx: BusinessContext, membershipId: string, input: unknown) {
  requirePermission(ctx, 'employee.manage_roles');
  assertCanWrite(ctx.subscription);
  const data = parseOrThrow(changeRoleSchema, input);

  return withTenant(ctx.business.id, async (tx) => {
    const m = await loadMemberInBusiness(tx, ctx.business.id, membershipId);
    if (m.status !== 'ACTIVE') throw Errors.conflict('Only active members can change role.');
    if (m.isOwner) throw Errors.conflict('The Owner role moves only by ownership transfer (business security settings).');
    const newRole = await assertCanGrantRole(tx, ctx, data.roleId);
    await assertCanManageTarget(tx, ctx, m.roleId);
    await tx.membership.update({ where: { id: m.id }, data: { roleId: newRole.id } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.memberRoleChanged,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'membership',
      resourceId: m.id,
      before: { roleId: m.roleId, roleKey: m.role.key, roleName: m.role.name },
      after: { roleId: newRole.id, roleKey: newRole.key, roleName: newRole.name },
      metadata: { reason: data.reason || null },
    });
    if (m.user) await emailUser(tx, m.user, 'security', (to, name) => templates.membershipChanged(to, m.user!.firstName || name, ctx.business.name, `Your role in ${ctx.business.name} changed from ${m.role.name} to ${newRole.name}.`));
  });
}

type StatusChange = 'suspend' | 'reactivate' | 'remove';

export async function changeMemberStatus(ctx: BusinessContext, membershipId: string, change: StatusChange) {
  requirePermission(ctx, 'employee.suspend');
  return withTenant(ctx.business.id, async (tx) => {
    const m = await loadMemberInBusiness(tx, ctx.business.id, membershipId);
    if (m.id === ctx.membership.id) throw Errors.conflict('You cannot change your own access.');
    if (m.isOwner) throw Errors.conflict('The Owner cannot be suspended or removed. Transfer ownership first.');
    await assertCanManageTarget(tx, ctx, m.roleId);

    const next = change === 'suspend' ? 'SUSPENDED' : change === 'reactivate' ? 'ACTIVE' : 'ARCHIVED';
    if (change === 'reactivate' && m.status !== 'SUSPENDED') throw Errors.conflict('Only suspended members can be reactivated.');
    if (change === 'suspend' && m.status !== 'ACTIVE') throw Errors.conflict('Only active members can be suspended.');
    if (change === 'remove' && (m.status === 'ARCHIVED' || m.status === 'INVITED')) throw Errors.conflict('Nothing to remove.');
    if (change === 'reactivate') {
      assertCanWrite(ctx.subscription);
      // A suspended member holds no seat, so coming back needs a free one.
      await assertWithinLimit(tx, ctx.business.id, ctx.subscription, 'members', 1, { excludeMembershipId: m.id });
    }

    await tx.membership.update({ where: { id: m.id }, data: { status: next } });
    // Historical records created by this person are untouched: only access ends.
    await recordAudit(tx, ctx.meta, {
      action: change === 'suspend' ? AuditActions.memberSuspended : change === 'reactivate' ? AuditActions.memberReactivated : AuditActions.memberRemoved,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'membership',
      resourceId: m.id,
      before: { status: m.status },
      after: { status: next },
    });
    if (m.user) {
      const msg = change === 'suspend' ? `Your access to ${ctx.business.name} was suspended.` : change === 'reactivate' ? `Your access to ${ctx.business.name} was restored.` : `You were removed from ${ctx.business.name}.`;
      await emailUser(tx, m.user, 'security', (to, name) => templates.membershipChanged(to, m.user!.firstName || name, ctx.business.name, msg));
    }
  });
}
