import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import type { Tx } from '@/server/db/client';
import type { Prisma } from '@/generated/prisma/client';
import { can, requirePermission } from '@/server/permissions/authorize';
import type { Permission } from '@/server/permissions/catalog';
import type { BusinessContext } from '@/server/context';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import { RESOURCES } from './registry';

/**
 * Who may do what to a stored file. The same rules answer a list ("which files may I see?") and a single request
 * ("may I open this one?"), so the two can never disagree. A browser's claim about a file's business, record or type is never
 * consulted: everything comes from the stored row, looked up inside the tenant.
 */
export type FileAction = 'view' | 'bytes' | 'edit' | 'delete' | 'share';

const ACTION_PERMISSION: Record<FileAction, Permission> = {
  view: 'document.view', bytes: 'document.download', edit: 'document.edit', delete: 'document.delete', share: 'document.share',
};

interface AccessRow {
  resourceType: string | null;
  visibility: string;
  locationId: string | null;
}

/** Throws FORBIDDEN / NOT_FOUND. Run inside withTenant. */
export async function assertFileAccess(tx: Tx, ctx: BusinessContext, row: AccessRow, action: FileAction): Promise<void> {
  requirePermission(ctx, ACTION_PERMISSION[action]);
  if (action !== 'view') requirePermission(ctx, 'document.view');
  const rule = row.resourceType ? RESOURCES[row.resourceType] : undefined;
  if (rule) {
    requirePermission(ctx, rule.view);
    if (action !== 'view' && action !== 'bytes' && rule.write) requirePermission(ctx, rule.write);
  }
  if (row.visibility === 'RESTRICTED') requirePermission(ctx, 'document.view_restricted');
  if (row.locationId) {
    const scope = await visibleLocationIds(tx, ctx);
    // A file at a location this person cannot use is "not found", the same answer as for another business's file.
    if (scope && !scope.includes(row.locationId)) throw Errors.notFound('File');
  }
}

export interface AccessFilter {
  hiddenTypes: string[];
  restrictedOk: boolean;
  /** null = every location. */
  scope: string[] | null;
}

export async function accessFilter(tx: Tx, ctx: BusinessContext): Promise<AccessFilter> {
  return {
    hiddenTypes: ['business_logo', ...Object.entries(RESOURCES).filter(([t, r]) => t !== 'business_logo' && !can(ctx, r.view)).map(([t]) => t)],
    restrictedOk: can(ctx, 'document.view_restricted'),
    scope: await visibleLocationIds(tx, ctx),
  };
}

/** The files a person may list (Prisma form). Mirrors assertFileAccess for 'view'. Run inside withTenant. */
export async function visibleFilesWhere(tx: Tx, ctx: BusinessContext): Promise<Prisma.FileWhereInput[]> {
  const f = await accessFilter(tx, ctx);
  const out: Prisma.FileWhereInput[] = [{ businessId: ctx.business.id }, { OR: [{ resourceType: null }, { resourceType: { notIn: f.hiddenTypes } }] }];
  if (!f.restrictedOk) out.push({ visibility: { not: 'RESTRICTED' } });
  const loc = locationWhere(f.scope);
  if (Object.keys(loc).length) out.push(loc);
  return out;
}

export type FileRow = Awaited<ReturnType<Tx['file']['findFirstOrThrow']>>;

/** Load one file of this business and check the person may do that action to it. A missing, other-business or deleted file is the same 404. */
export async function loadFile(tx: Tx, ctx: BusinessContext, id: string, action: FileAction, opts: { statuses?: string[] } = {}): Promise<FileRow> {
  const fileId = parseOrThrow(uuidSchema, id);
  const row = await tx.file.findFirst({ where: { id: fileId, businessId: ctx.business.id } });
  const allowed = opts.statuses ?? ['ACTIVE', 'ARCHIVED'];
  // A trashed file is still visible to the people who can restore it; a deleted one is gone for everyone.
  const visible = row && (allowed.includes(row.status) || (row.status === 'TRASHED' && can(ctx, 'document.delete')));
  if (!row || !visible) throw Errors.notFound('File');
  await assertFileAccess(tx, ctx, row, action);
  return row;
}
