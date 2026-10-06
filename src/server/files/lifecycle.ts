import { Errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { prisma, withTenant, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requirePermission } from '@/server/permissions/authorize';
import { getStorage } from '@/server/storage';
import type { BusinessContext } from '@/server/context';
import { loadFile as loadFileForAction } from './access';
import { loadDocumentSettings } from './settings';

/**
 * Document lifecycle:  Active -> Archived -> Trash -> Permanently deleted.
 *
 *  - Archive hides a document from everyday lists; it stays fully readable and is restorable.
 *  - Trash is the "delete" button. Nothing is destroyed: the file waits in the trash for the retention period and can be restored.
 *  - Permanent deletion needs its own permission, the file must already be in the trash, and the database refuses it for a financial
 *    document still inside its retention period (and refuses to trash one at all). The row stays as a record that it existed; only
 *    the stored object goes.
 */
const reload = (tx: Tx, businessId: string, id: string) => tx.file.findFirstOrThrow({ where: { id, businessId } });

export async function archiveFile(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'document.delete');
  assertCanWrite(ctx.subscription);
  return withTenant(ctx.business.id, async (tx) => {
    const row = await loadFileForAction(tx, ctx, id, 'delete', { statuses: ['ACTIVE'] });
    await tx.file.update({ where: { id: row.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.fileArchived, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', resourceId: row.id, metadata: { name: row.originalName } });
  });
}

/** Bring a file back from the archive or from the trash. */
export async function restoreFile(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'document.delete');
  assertCanWrite(ctx.subscription);
  return withTenant(ctx.business.id, async (tx) => {
    const row = await loadFileForAction(tx, ctx, id, 'delete', { statuses: ['ARCHIVED', 'TRASHED'] });
    await tx.file.update({ where: { id: row.id }, data: { status: 'ACTIVE', archivedAt: null, trashedAt: null, trashedById: null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.fileRestored, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', resourceId: row.id, metadata: { name: row.originalName, from: row.status } });
    return reload(tx, ctx.business.id, row.id);
  });
}

export async function trashFile(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'document.delete');
  assertCanWrite(ctx.subscription);
  return withTenant(ctx.business.id, async (tx) => {
    const row = await loadFileForAction(tx, ctx, id, 'delete', { statuses: ['ACTIVE', 'ARCHIVED'] });
    if (row.isFinancial) throw Errors.conflict('Financial documents are kept for their retention period and cannot be deleted. You can archive this one instead.');
    await tx.file.update({ where: { id: row.id }, data: { status: 'TRASHED', trashedAt: new Date(), trashedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.fileTrashed, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', resourceId: row.id, metadata: { name: row.originalName } });
    return reload(tx, ctx.business.id, row.id);
  });
}

/** Remove the stored objects of a file that has been marked DELETED (called after the row update succeeded). */
async function removeObjects(row: { storageKey: string; thumbnailKey: string | null }) {
  const storage = getStorage();
  await storage.delete(row.storageKey);
  if (row.thumbnailKey) await storage.delete(row.thumbnailKey).catch((e) => logger.warn({ err: String(e) }, 'thumbnail delete failed'));
}

async function purgeRow(tx: Tx, businessId: string, rowId: string) {
  const row = await reload(tx, businessId, rowId);
  // The database trigger is the real gate: it refuses a file that is not in the trash, or a financial one inside its retention period.
  await tx.file.update({ where: { id: row.id }, data: { status: 'DELETED', deletedAt: new Date() } });
  await removeObjects(row); // if the object cannot be removed the whole change is undone
  return row;
}

export async function purgeFile(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'document.purge');
  assertCanWrite(ctx.subscription);
  const fileId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const row = await loadFileForAction(tx, ctx, fileId, 'delete', { statuses: ['TRASHED'] });
    if (row.status !== 'TRASHED') throw Errors.conflict('Move the document to the trash first.');
    if (row.isFinancial && (!row.retainUntil || row.retainUntil > new Date())) throw Errors.conflict('This financial document is inside its retention period and cannot be permanently deleted.');
    await purgeRow(tx, ctx.business.id, row.id);
    await recordAudit(tx, ctx.meta, { action: AuditActions.filePurged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', resourceId: row.id, metadata: { name: row.originalName, size: row.sizeBytes } });
  });
}

export interface CleanupResult {
  purged: number;
  skipped: number;
  businesses: number;
}

/**
 * Conservative scheduled cleanup. It does exactly one thing: permanently remove files that have sat in the trash longer than the
 * business's retention period. It never touches an active or archived file, never touches a financial document inside its retention,
 * and writes an audit entry for every file it removes. A file it cannot remove is left alone and counted.
 */
export async function purgeExpiredTrash(now = new Date(), limitPerBusiness = 200): Promise<CleanupResult> {
  const out: CleanupResult = { purged: 0, skipped: 0, businesses: 0 };
  const businesses = await prisma().business.findMany({ where: { status: 'ACTIVE' }, select: { id: true } }).catch(() => []);
  for (const { id: businessId } of businesses) {
    const ids = await withTenant(businessId, async (tx) => {
      const settings = await loadDocumentSettings(tx, businessId);
      const cutoff = new Date(now.getTime() - settings.trashRetentionDays * 86_400_000);
      const rows = await tx.file.findMany({ where: { businessId, status: 'TRASHED', trashedAt: { lt: cutoff }, isFinancial: false }, select: { id: true }, take: limitPerBusiness });
      return rows.map((r) => r.id);
    });
    if (ids.length) out.businesses++;
    for (const id of ids) {
      try {
        await withTenant(businessId, async (tx) => {
          const row = await purgeRow(tx, businessId, id);
          await recordAudit(tx, undefined, { action: AuditActions.documentCleanup, businessId, resourceType: 'file', resourceId: id, metadata: { reason: 'trash retention period passed', name: row.originalName, size: row.sizeBytes } });
        });
        out.purged++;
      } catch (err) {
        out.skipped++;
        logger.warn({ err: String(err), fileId: id }, 'trash cleanup skipped a file');
      }
    }
  }
  return out;
}

export interface OrphanResult {
  checked: number;
  removed: number;
  /** In report-only mode: how many would have been removed. */
  wouldRemove: number;
}

/**
 * Conservative cleanup of stored objects that no record points to (left behind if a server died between writing an object and committing
 * its record). It removes ONLY an object that (a) sits under this business's own prefix, (b) is older than `minAgeMs` (so an upload that is still
 * in flight is never touched), and (c) is referenced by no file, thumbnail or data export. At most `limit` per business per run, and every
 * removal is audited. With apply=false it only reports.
 */
export async function cleanupOrphanObjects(now = new Date(), opts: { apply?: boolean; minAgeMs?: number; limit?: number; businessId?: string } = {}): Promise<OrphanResult> {
  const storage = getStorage();
  const out: OrphanResult = { checked: 0, removed: 0, wouldRemove: 0 };
  if (!storage.list) return out;
  const apply = opts.apply ?? true;
  const minAge = opts.minAgeMs ?? 3 * 86_400_000;
  const limit = opts.limit ?? 200;
  const businesses = opts.businessId ? [{ id: opts.businessId }] : await prisma().business.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  for (const { id: businessId } of businesses) {
    const objects = await storage.list(`${businessId}/`, { limit: 5000 }).catch(() => []);
    if (objects.length === 0) continue;
    const old = objects.filter((o) => now.getTime() - o.lastModified.getTime() >= minAge);
    out.checked += objects.length;
    if (old.length === 0) continue;
    const referenced = await withTenant(businessId, async (tx) => {
      const files = await tx.file.findMany({ where: { businessId, status: { not: 'DELETED' } }, select: { storageKey: true, thumbnailKey: true } });
      const exportsRows = await tx.dataExport.findMany({ where: { businessId, storageKey: { not: null } }, select: { storageKey: true } });
      return new Set([...files.flatMap((f) => [f.storageKey, f.thumbnailKey ?? '']), ...exportsRows.map((e) => e.storageKey ?? '')]);
    });
    const orphans = old.filter((o) => !referenced.has(o.key)).slice(0, limit);
    out.wouldRemove += orphans.length;
    if (!apply || orphans.length === 0) continue;
    let removed = 0;
    for (const o of orphans) {
      try { await storage.delete(o.key); removed++; } catch (err) { logger.warn({ err: String(err), key: o.key }, 'orphan object could not be removed'); }
    }
    out.removed += removed;
    await withTenant(businessId, (tx) => recordAudit(tx, undefined, { action: AuditActions.documentCleanup, businessId, resourceType: 'storage', metadata: { reason: 'objects with no record, older than the safety window', removed, examined: objects.length } })).catch(() => {});
  }
  return out;
}
