import { logger } from '@/lib/logger';
import { seq, withTenant } from '@/server/db/client';
import { requirePermission } from '@/server/permissions/authorize';
import { getStorage } from '@/server/storage';
import type { BusinessContext } from '@/server/context';
import { BUILTIN_CATEGORIES } from './categories';
import { RESOURCES } from './registry';

/**
 * Storage usage. The file records are the authority: every figure here is computed from them on request (never from a counter a
 * browser or a cache could drift), and a reconcile check proves each record still has its stored object.
 * Files in the trash still occupy storage until they are permanently deleted, so they count.
 */
export const COUNTED_STATUSES = ['ACTIVE', 'ARCHIVED', 'TRASHED'] as const;

export interface StorageReport {
  usedBytes: number;
  limitBytes: number;
  percentUsed: number;
  state: 'ok' | 'near' | 'full' | 'over';
  fileCount: number;
  trashBytes: number;
  byCategory: { key: string; label: string; bytes: number; files: number }[];
  byRecordType: { key: string; label: string; bytes: number; files: number }[];
  largest: { id: string; name: string; sizeBytes: number; category: string }[];
}

export async function getStorageReport(ctx: BusinessContext): Promise<StorageReport> {
  requirePermission(ctx, 'document.view');
  const biz = ctx.business.id;
  const limitBytes = ctx.subscription.limits.storageMb * 1024 * 1024;
  return withTenant(biz, async (tx) => {
    const base = { businessId: biz, status: { in: [...COUNTED_STATUSES] } };
    const [agg, trash, cats, types, largest, custom] = await seq([
      tx.file.aggregate({ where: base, _sum: { sizeBytes: true }, _count: true }),
      tx.file.aggregate({ where: { businessId: biz, status: 'TRASHED' }, _sum: { sizeBytes: true } }),
      tx.file.groupBy({ by: ['category'], where: base, _sum: { sizeBytes: true }, _count: true }),
      tx.file.groupBy({ by: ['resourceType'], where: base, _sum: { sizeBytes: true }, _count: true }),
      tx.file.findMany({ where: { businessId: biz, status: { in: ['ACTIVE', 'ARCHIVED'] } }, orderBy: { sizeBytes: 'desc' }, take: 5, select: { id: true, displayName: true, originalName: true, sizeBytes: true, category: true } }),
      tx.documentCategory.findMany({ where: { businessId: biz } }),
    ]);
    const used = agg._sum.sizeBytes ?? 0;
    const pct = limitBytes > 0 ? Math.round((used / limitBytes) * 1000) / 10 : 100;
    const labels = new Map<string, string>([...Object.entries(BUILTIN_CATEGORIES), ...custom.map((c) => [c.key, c.label] as [string, string])]);
    return {
      usedBytes: used, limitBytes, percentUsed: pct, state: used > limitBytes ? 'over' : pct >= 100 ? 'full' : pct >= 85 ? 'near' : 'ok',
      fileCount: agg._count, trashBytes: trash._sum.sizeBytes ?? 0,
      byCategory: cats.map((c) => ({ key: c.category, label: labels.get(c.category) ?? c.category, bytes: c._sum.sizeBytes ?? 0, files: c._count })).sort((a, b) => b.bytes - a.bytes),
      byRecordType: types.map((t) => ({ key: t.resourceType ?? 'none', label: t.resourceType ? RESOURCES[t.resourceType]?.label ?? t.resourceType : 'Not attached to a record', bytes: t._sum.sizeBytes ?? 0, files: t._count })).sort((a, b) => b.bytes - a.bytes),
      largest: largest.map((f) => ({ id: f.id, name: f.displayName || f.originalName, sizeBytes: f.sizeBytes, category: f.category })),
    };
  });
}

export interface ReconcileResult {
  checked: number;
  missingObjects: { id: string; name: string }[];
}

/** Check that the stored objects behind this business's file records exist (the records stay authoritative; nothing is changed). */
export async function reconcileStorage(ctx: BusinessContext, limit = 500): Promise<ReconcileResult> {
  requirePermission(ctx, 'document.manage');
  const rows = await withTenant(ctx.business.id, (tx) => tx.file.findMany({ where: { businessId: ctx.business.id, status: { in: ['ACTIVE', 'ARCHIVED'] } }, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, originalName: true, storageKey: true } }));
  const storage = getStorage();
  const missing: { id: string; name: string }[] = [];
  for (const r of rows) {
    try {
      if (!(await storage.exists(r.storageKey))) missing.push({ id: r.id, name: r.originalName });
    } catch (err) {
      logger.warn({ err: String(err), fileId: r.id }, 'storage check failed');
    }
  }
  return { checked: rows.length, missingObjects: missing };
}
