import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma, withTenant, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { appUrl } from '@/lib/url';
import { logger } from '@/lib/logger';
import { pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { requireFeature } from '@/server/billing/features';
import { enqueue } from '@/server/jobs/queue';
import { JobTypes } from '@/server/jobs/types';
import { emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { can, requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import { sha256Hex } from '@/server/security/crypto';
import { getPlatformSettings } from '@/server/settings/platform';
import { getStorage } from '@/server/storage';
import { systemMeta, type BusinessContext } from '@/server/context';
import { datasetByKey, EXPORT_DATASETS } from './registry';

export const exportRequestSchema = z.object({ datasets: z.array(z.string().max(40)).max(30).optional() });
export const exportListSchema = paginationSchema;

/** Datasets this person may export (each dataset needs its own permission). */
export const exportableDatasets = (ctx: BusinessContext) => EXPORT_DATASETS.filter((d) => can(ctx, d.permission));

/**
 * Ask for a business data export. Generated in the background (never blocking the request),
 * restricted to datasets the requester is allowed to see, stored privately, and downloadable only
 * by authorised members until it expires. Allowed even in read-only mode: customers must always be
 * able to take their data with them.
 */
export async function requestExport(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'business.export');
  requireFeature(ctx.subscription, 'data_export');
  const { datasets } = parseOrThrow(exportRequestSchema, input);
  await consume({ key: `export:business:${ctx.business.id}`, limit: 3, windowSec: 3600 });

  const allowed = exportableDatasets(ctx);
  const scope = datasets ? datasets : allowed.map((d) => d.key);
  for (const k of scope) {
    const d = datasetByKey(k);
    if (!d) throw Errors.validation({ datasets: `Unknown dataset "${k}".` });
    if (!allowed.includes(d)) throw Errors.forbidden(`You do not have permission to export ${d.label.toLowerCase()}.`);
  }
  if (scope.length === 0) throw Errors.validation({ datasets: 'Nothing to export.' });

  return withTenant(ctx.business.id, async (tx) => {
    const row = await tx.dataExport.create({ data: { businessId: ctx.business.id, requestedById: ctx.user.id, scope } });
    await enqueue(tx, JobTypes.exportGenerate, { exportId: row.id, businessId: ctx.business.id }, { dedupeKey: `export:${row.id}`, businessId: ctx.business.id });
    await recordAudit(tx, ctx.meta, { action: AuditActions.exportRequested, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'data_export', resourceId: row.id, metadata: { scope } });
    return { id: row.id, status: row.status, scope };
  });
}

export async function listExports(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'business.export');
  const q = parseOrThrow(exportListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const where = { businessId: ctx.business.id };
    const [total, rows] = await seq([
      tx.dataExport.count({ where }),
      tx.dataExport.findMany({ where, orderBy: { requestedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const now = new Date();
    return {
      items: rows.map((r) => ({
        id: r.id, scope: r.scope, requestedAt: r.requestedAt, completedAt: r.completedAt, sizeBytes: r.sizeBytes,
        status: r.status === 'READY' && r.expiresAt && r.expiresAt <= now ? 'EXPIRED' : r.status,
        expiresAt: r.expiresAt, error: r.status === 'FAILED' ? 'The export could not be generated. Please try again.' : null,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

/** Background job: build the file. Failures are recorded on the export (and logged), not retried blindly. */
export async function runExport(p: { exportId: string; businessId: string }): Promise<void> {
  const settings = await getPlatformSettings();
  const claimed = await withTenant(p.businessId, async (tx) => {
    const r = await tx.dataExport.updateMany({ where: { id: p.exportId, businessId: p.businessId, status: 'PENDING' }, data: { status: 'PROCESSING' } });
    return r.count === 1 ? tx.dataExport.findUniqueOrThrow({ where: { id: p.exportId } }) : null;
  });
  if (!claimed) return; // already handled

  try {
    const data = await withTenant(p.businessId, async (tx) => {
      const out: Record<string, unknown[]> = {};
      for (const key of claimed.scope) {
        const d = datasetByKey(key);
        if (d) out[key] = await d.fetch(tx, p.businessId);
      }
      return out;
    });
    const business = await prisma().business.findUniqueOrThrow({ where: { id: p.businessId }, select: { name: true } });
    const body = Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), business: business.name, datasets: data }), 'utf8');
    const key = `${p.businessId}/${new Date().getUTCFullYear()}/${randomUUID()}`;
    await getStorage().put(key, body, { contentType: 'application/json' });

    const expiresAt = new Date(Date.now() + settings.exportRetentionDays * 86_400_000);
    await withTenant(p.businessId, async (tx) => {
      await tx.dataExport.update({ where: { id: p.exportId }, data: { status: 'READY', storageKey: key, sizeBytes: body.length, sha256: sha256Hex(body), completedAt: new Date(), expiresAt } });
      await recordAudit(tx, systemMeta('export'), { action: AuditActions.dataExported, businessId: p.businessId, userId: claimed.requestedById, resourceType: 'data_export', resourceId: p.exportId, metadata: { scope: claimed.scope, sizeBytes: body.length } });
      const user = claimed.requestedById ? await tx.user.findUnique({ where: { id: claimed.requestedById } }) : null;
      if (user) await emailUser(tx, user, 'account', (to, name) => templates.exportReady(to, user.firstName || name, business.name, appUrl('/settings/export'), settings.exportRetentionDays));
    });
  } catch (err) {
    logger.error({ exportId: p.exportId, err: String(err) }, 'export generation failed');
    await withTenant(p.businessId, (tx) => tx.dataExport.update({ where: { id: p.exportId }, data: { status: 'FAILED', error: String(err).slice(0, 300) } }));
  }
}

/** Authorise and open a finished export. Another business's export id is simply "not found". */
export async function openExport(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'business.export');
  const exportId = parseOrThrow(uuidSchema, id);
  const row = await withTenant(ctx.business.id, (tx) => tx.dataExport.findFirst({ where: { id: exportId, businessId: ctx.business.id } }));
  if (!row || row.status !== 'READY' || !row.storageKey || !row.expiresAt || row.expiresAt <= new Date()) throw Errors.notFound('Export');
  const { stream, size } = await getStorage().get(row.storageKey);
  await withTenant(ctx.business.id, (tx) =>
    recordAudit(tx, ctx.meta, { action: AuditActions.exportDownloaded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'data_export', resourceId: row.id }),
  );
  return { stream, size: size ?? row.sizeBytes ?? 0, filename: `tfme-auto-export-${row.requestedAt.toISOString().slice(0, 10)}.json` };
}
