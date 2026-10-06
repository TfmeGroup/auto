import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { escapeLike, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

/**
 * Part categories belong to the business (nothing is hard-coded). A category can have sub-categories one level down. Categories
 * are archived, never deleted, so the parts and history that point at them stay readable.
 */

export const categorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60),
  parentId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : null)),
  sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
});

export async function listCategories(ctx: BusinessContext, opts: { includeArchived?: boolean } = {}) {
  requirePermission(ctx, 'inventory.view');
  return withTenant(ctx.business.id, async (tx) => {
    const cats = await tx.partCategory.findMany({
      where: { businessId: ctx.business.id, ...(opts.includeArchived ? {} : { status: 'ACTIVE' }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await tx.part.groupBy({ by: ['categoryId'], where: { businessId: ctx.business.id, status: { not: 'ARCHIVED' }, categoryId: { not: null } }, _count: { _all: true } });
    const n = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    return cats.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder, status: c.status, partCount: n.get(c.id) ?? 0 }));
  });
}

async function assertNameFree(tx: import('@/server/db/client').Tx, businessId: string, name: string, parentId: string | null, exceptId?: string) {
  const dup = await tx.partCategory.findFirst({
    where: { businessId, status: 'ACTIVE', parentId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (dup) throw Errors.validation({ name: 'A category with that name already exists here.' });
}

async function assertParent(tx: import('@/server/db/client').Tx, businessId: string, parentId: string | null, selfId?: string) {
  if (!parentId) return;
  if (parentId === selfId) throw Errors.validation({ parentId: 'A category cannot be its own parent.' });
  const p = await tx.partCategory.findFirst({ where: { id: parentId, businessId, status: 'ACTIVE' } });
  if (!p) throw Errors.validation({ parentId: 'Choose a category of this business.' });
  if (p.parentId) throw Errors.validation({ parentId: 'Sub-categories can only go one level deep.' });
}

export async function createCategory(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(categorySchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await assertParent(tx, ctx.business.id, d.parentId);
    await assertNameFree(tx, ctx.business.id, d.name, d.parentId);
    const c = await tx.partCategory.create({ data: { businessId: ctx.business.id, name: d.name, parentId: d.parentId, sortOrder: d.sortOrder ?? 0, createdById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.partCategoryCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part_category', resourceId: c.id, after: { name: c.name, parentId: c.parentId } });
    return c;
  });
}

export async function updateCategory(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(categorySchema.partial(), input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.partCategory.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Category');
    const name = d.name ?? before.name;
    const parentId = d.parentId !== undefined ? d.parentId : before.parentId;
    if (parentId && (await tx.partCategory.count({ where: { businessId: ctx.business.id, parentId: id } })) > 0) throw Errors.validation({ parentId: 'This category has sub-categories, so it cannot become one.' });
    await assertParent(tx, ctx.business.id, parentId, id);
    if (before.status === 'ACTIVE') await assertNameFree(tx, ctx.business.id, name, parentId, id);
    const after = await tx.partCategory.update({ where: { id }, data: { name, parentId, ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}) } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.partCategoryUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part_category', resourceId: id, before: { name: before.name, parentId: before.parentId }, after: { name: after.name, parentId: after.parentId } });
    return after;
  });
}

export async function setCategoryArchived(ctx: BusinessContext, id: string, archived: boolean) {
  requirePermission(ctx, 'inventory.edit');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await tx.partCategory.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!c) throw Errors.notFound('Category');
    if (archived) {
      if (c.status === 'ARCHIVED') return c;
      if ((await tx.partCategory.count({ where: { businessId: ctx.business.id, parentId: id, status: 'ACTIVE' } })) > 0) throw Errors.conflict('Archive its sub-categories first.');
    } else {
      if (c.status === 'ACTIVE') return c;
      await assertNameFree(tx, ctx.business.id, c.name, c.parentId, id);
      if (c.parentId && !(await tx.partCategory.findFirst({ where: { id: c.parentId, businessId: ctx.business.id, status: 'ACTIVE' } }))) throw Errors.conflict('Restore its parent category first.');
    }
    const after = await tx.partCategory.update({ where: { id }, data: { status: archived ? 'ARCHIVED' : 'ACTIVE' } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.partCategoryArchived, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'part_category', resourceId: id, before: { status: c.status }, after: { status: after.status }, metadata: { name: c.name } });
    return after;
  });
}

/** Names containing LIKE wildcards are matched literally everywhere categories are searched by text. */
export const likeOf = (s: string) => `%${escapeLike(s)}%`;
