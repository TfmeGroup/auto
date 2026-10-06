import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma, withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { optionalText, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { requirePermission } from '@/server/permissions/authorize';
import { ALL_PERMISSIONS, isPermission, PERMISSIONS, type Permission } from '@/server/permissions/catalog';
import type { BusinessContext } from '@/server/context';

/**
 * Custom roles (foundation). A custom role is just a named set of catalogue permissions stored for ONE
 * business. Guards: plan entitlement (custom_roles), nobody can create/edit a role granting permissions
 * they do not hold, system roles can never be changed (database trigger), and a role in use is archived —
 * never deleted — so history keeps its meaning.
 */
export const roleInputSchema = z.object({
  name: z.string().trim().min(2, 'Give the role a name').max(60),
  description: optionalText(200),
  permissions: z.array(z.string()).min(1, 'Pick at least one permission').max(ALL_PERMISSIONS.length),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'role';

function validPermissions(ctx: BusinessContext, raw: string[]): Permission[] {
  const unknown = raw.filter((p) => !isPermission(p));
  if (unknown.length) throw Errors.validation({ permissions: `Unknown permission: ${unknown[0]}` });
  const perms = [...new Set(raw)] as Permission[];
  const missing = perms.find((p) => !ctx.permissions.has(p));
  if (missing) throw Errors.forbidden(`You cannot grant "${PERMISSIONS[missing]}" because you do not have it yourself.`);
  return perms;
}

export async function listRoles(ctx: BusinessContext) {
  requirePermission(ctx, 'employee.view');
  const roles = await prisma().role.findMany({
    where: { OR: [{ businessId: null }, { businessId: ctx.business.id }] },
    include: { permissions: true, _count: { select: { memberships: { where: { businessId: ctx.business.id, status: { in: ['ACTIVE', 'INVITED'] } } } } } },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
  });
  return roles.map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, archived: r.archivedAt !== null,
    permissions: r.permissions.map((p) => p.permission).filter(isPermission).sort(), memberCount: r._count.memberships,
  }));
}

export async function createRole(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'employee.manage_roles');
  assertCanWrite(ctx.subscription);
  requireFeature(ctx.subscription, 'custom_roles');
  const data = parseOrThrow(roleInputSchema, input);
  const perms = validPermissions(ctx, data.permissions);

  return withTenant(ctx.business.id, async (tx) => {
    const clash = await tx.role.findFirst({ where: { businessId: ctx.business.id, name: { equals: data.name, mode: 'insensitive' }, archivedAt: null } });
    if (clash) throw Errors.conflict('A role with that name already exists.');
    const role = await tx.role.create({
      data: { businessId: ctx.business.id, key: `custom_${slug(data.name)}_${randomBytes(2).toString('hex')}`, name: data.name, description: data.description, isSystem: false },
    });
    await tx.rolePermission.createMany({ data: perms.map((permission) => ({ roleId: role.id, permission })) });
    await recordAudit(tx, ctx.meta, { action: AuditActions.roleCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'role', resourceId: role.id, after: { name: role.name, permissions: perms } });
    return { id: role.id, name: role.name, permissions: perms };
  });
}

async function loadCustomRole(ctx: BusinessContext, id: string) {
  parseOrThrow(uuidSchema, id);
  const role = await prisma().role.findFirst({ where: { id, businessId: ctx.business.id }, include: { permissions: true } });
  if (!role) throw Errors.notFound('Role');
  if (role.isSystem) throw Errors.forbidden('System roles cannot be changed.');
  if (role.archivedAt) throw Errors.conflict('This role is archived.');
  // Cannot edit a role that is more powerful than you are.
  for (const p of role.permissions) if (isPermission(p.permission) && !ctx.permissions.has(p.permission)) throw Errors.forbidden('You cannot edit a role with more access than your own.');
  return role;
}

export async function updateRole(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'employee.manage_roles');
  assertCanWrite(ctx.subscription);
  requireFeature(ctx.subscription, 'custom_roles');
  const data = parseOrThrow(roleInputSchema, input);
  const perms = validPermissions(ctx, data.permissions);
  const role = await loadCustomRole(ctx, id);
  const before = role.permissions.map((p) => p.permission).sort();

  return withTenant(ctx.business.id, async (tx) => {
    await tx.role.update({ where: { id: role.id }, data: { name: data.name, description: data.description ?? null } });
    await tx.rolePermission.deleteMany({ where: { roleId: role.id, permission: { notIn: perms } } });
    await tx.rolePermission.createMany({ data: perms.map((permission) => ({ roleId: role.id, permission })), skipDuplicates: true });
    const after = [...perms].sort();
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    await recordAudit(tx, ctx.meta, { action: changed ? AuditActions.rolePermissionsChanged : AuditActions.roleCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'role', resourceId: role.id, before: { name: role.name, permissions: before }, after: { name: data.name, permissions: after } });
    if (changed) {
      // Everyone holding the role hears about the change to their access.
      const holders = await tx.membership.findMany({ where: { roleId: role.id, status: 'ACTIVE', userId: { not: null } }, include: { user: true } });
      for (const h of holders) if (h.user) await emailUser(tx, h.user, 'security', (to, name) => templates.roleChanged(to, h.user!.firstName || name, ctx.business.name, data.name));
    }
    return { id: role.id, name: data.name, permissions: after };
  });
}

export async function archiveRole(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'employee.manage_roles');
  assertCanWrite(ctx.subscription);
  const role = await loadCustomRole(ctx, id);
  const inUse = await prisma().membership.count({ where: { roleId: role.id, businessId: ctx.business.id, status: { in: ['ACTIVE', 'INVITED', 'SUSPENDED'] } } });
  if (inUse > 0) throw Errors.conflict(`${inUse} member${inUse === 1 ? ' is' : 's are'} still assigned this role. Move them to another role first.`);
  await withTenant(ctx.business.id, async (tx) => {
    await tx.role.update({ where: { id: role.id }, data: { archivedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.roleArchived, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'role', resourceId: role.id, metadata: { name: role.name } });
  });
}
