import { z } from 'zod';
import { Errors, AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { appUrl } from '@/lib/url';
import { pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, seq, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import { getStorage } from '@/server/storage';
import { StorageNotFoundError } from '@/server/storage/types';
import type { BusinessContext } from '@/server/context';
import { visibleLocationIds } from '@/server/workshop/people';
import { assertCategory, BUILTIN_CATEGORIES, FINANCIAL_CATEGORIES } from './categories';
import { loadFile, visibleFilesWhere } from './access';
import { RESOURCES } from './registry';
import { scanUpload } from './scan';
import { loadDocumentSettings } from './settings';
import { signFileLink, verifyFileLink, DEFAULT_TTL_SEC } from './signed';
import { assertDecodableImage, storeFile } from './store';
import type { FileRow } from './access';
import { detectFileType, sanitizeFilename } from './sniff';

export { archiveFile } from './lifecycle';

const visibilitySchema = z.enum(['INTERNAL', 'CUSTOMER', 'RESTRICTED']);

export const fileListSchema = paginationSchema.extend({
  resourceType: z.string().max(40).optional(),
  resourceId: uuidSchema.optional(),
  category: z.string().max(60).optional(),
});

export interface UploadInput {
  data: Buffer;
  filename: string;
  resourceType?: string;
  resourceId?: string;
  category?: string;
  visibility?: 'INTERNAL' | 'CUSTOMER' | 'RESTRICTED';
  description?: string;
  displayName?: string;
  /** The caller already authorised this upload under a different permission (e.g. business.edit for a logo). */
  authorisedBy?: 'business.edit' | 'job.edit';
  /** Reject anything whose detected type is not in this set (before anything is stored). */
  allowedMimes?: ReadonlySet<string>;
}

/** Validate an upload completely (size, real type, scan) and store it. */
export async function uploadFile(ctx: BusinessContext, input: UploadInput) {
  if (input.authorisedBy) requirePermission(ctx, input.authorisedBy);
  else requirePermission(ctx, 'document.upload');
  assertCanWrite(ctx.subscription);

  if ((input.resourceType === undefined) !== (input.resourceId === undefined)) throw Errors.validation({ resourceId: 'resourceType and resourceId must be given together.' });
  const rule = input.resourceType ? RESOURCES[input.resourceType] : undefined;
  if (input.resourceType && !rule) throw Errors.validation({ resourceType: 'Unsupported resource type.' });
  if (input.resourceType === 'business_logo' && input.authorisedBy !== 'business.edit') throw Errors.forbidden();
  if (!input.authorisedBy) {
    if (rule?.write) requirePermission(ctx, rule.write);
    if (rule) requirePermission(ctx, rule.view);
  }
  if (input.visibility === 'CUSTOMER' && !input.authorisedBy) requirePermission(ctx, 'document.share');
  if (input.visibility === 'RESTRICTED') requirePermission(ctx, 'document.view_restricted');
  const description = input.description?.trim().slice(0, 500) || undefined;
  const displayName = input.displayName?.trim().slice(0, 150) || undefined;

  const settings = await withTenant(ctx.business.id, (tx) => loadDocumentSettings(tx, ctx.business.id));
  const maxBytes = settings.effectiveMaxUploadMb * 1024 * 1024;
  if (input.data.length === 0) throw Errors.validation({ file: 'The file is empty.' });
  if (input.data.length > maxBytes) throw Errors.tooLarge(settings.effectiveMaxUploadMb);

  const filename = sanitizeFilename(input.filename);
  const detected = detectFileType(input.data, filename);
  if (!detected) throw Errors.unsupportedMedia('Allowed files: photos (JPG, PNG, WebP, GIF, HEIC), PDF, Word, Excel, CSV and text.');
  if (input.allowedMimes && !input.allowedMimes.has(detected.mime)) throw Errors.unsupportedMedia('That file type is not allowed here.');
  await assertDecodableImage(input.data, detected.mime);

  // Where the record sits decides whether this person may use it (location access), before anything is stored.
  if (input.resourceType && input.resourceId && !input.authorisedBy) {
    await withTenant(ctx.business.id, async (tx) => {
      const owner = await rule!.owner(tx, ctx.business.id, input.resourceId!);
      if (!owner) throw Errors.notFound('Record');
      const scope = owner.locationId ? await visibleLocationIds(tx, ctx) : null;
      if (owner.locationId && scope && !scope.includes(owner.locationId)) throw Errors.notFound('Record');
    });
  }

  const scan = await scanUpload(input.data, detected.mime);
  if (!scan.ok) {
    if (scan.failure.kind === 'flagged') {
      await withTenant(ctx.business.id, (tx) =>
        recordAudit(tx, ctx.meta, { action: AuditActions.fileScanFlagged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', metadata: { name: filename, engine: scan.failure.engine, reason: scan.failure.reason } }),
      ).catch(() => {});
      throw Errors.unsupportedMedia(`This file was refused: ${scan.failure.reason}`);
    }
    logger.error({ engine: scan.failure.engine, reason: scan.failure.reason }, 'upload scan unavailable');
    throw new AppError('BAD_REQUEST', 503, 'Files cannot be checked right now, so uploads are paused. Please try again in a few minutes.');
  }

  const file = await storeFile({
    businessId: ctx.business.id, actorId: ctx.user.id, meta: ctx.meta, data: input.data, filename, mime: detected.mime, ext: detected.ext,
    resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null, category: input.category, visibility: input.visibility, description, displayName, source: 'UPLOAD', scan: scan.outcome,
  });
  return toView(file);
}

// ───────── presentation ─────────

export interface FileView {
  id: string;
  /** What to show: the display name, else the original filename. */
  name: string;
  originalName: string;
  displayName: string | null;
  mimeType: string;
  extension: string | null;
  sizeBytes: number;
  category: string;
  visibility: 'INTERNAL' | 'CUSTOMER' | 'RESTRICTED';
  version: number;
  isCurrent: boolean;
  status: string;
  source: string;
  generatedKind: string | null;
  resourceType: string | null;
  resourceId: string | null;
  customerId: string | null;
  locationId: string | null;
  description: string | null;
  uploadedById: string | null;
  uploadedByName?: string | null;
  scanStatus: string;
  isFinancial: boolean;
  retainUntil: Date | null;
  hasThumbnail: boolean;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
}

export const toView = (f: FileRow, uploaderName?: string | null): FileView => ({
  id: f.id, name: f.displayName || f.originalName, originalName: f.originalName, displayName: f.displayName, mimeType: f.mimeType, extension: f.extension, sizeBytes: f.sizeBytes, category: f.category,
  visibility: f.visibility, version: f.version, isCurrent: f.isCurrent, status: f.status, source: f.source, generatedKind: f.generatedKind, resourceType: f.resourceType, resourceId: f.resourceId,
  customerId: f.customerId, locationId: f.locationId, description: f.description, uploadedById: f.uploadedById, uploadedByName: uploaderName, scanStatus: f.scanStatus, isFinancial: f.isFinancial,
  retainUntil: f.retainUntil, hasThumbnail: !!f.thumbnailKey, createdAt: f.createdAt, updatedAt: f.updatedAt, trashedAt: f.trashedAt,
});

export async function uploaderNames(tx: Tx, businessId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return new Map();
  const rows = await tx.membership.findMany({ where: { businessId, userId: { in: unique } }, select: { userId: true, user: { select: { name: true } } } });
  return new Map(rows.flatMap((r) => (r.userId && r.user ? [[r.userId, r.user.name] as const] : [])));
}

export async function presentFiles(tx: Tx, businessId: string, rows: FileRow[]): Promise<FileView[]> {
  const names = await uploaderNames(tx, businessId, rows.map((r) => r.uploadedById));
  return rows.map((r) => toView(r, r.uploadedById ? names.get(r.uploadedById) ?? null : null));
}

// ───────── listing ─────────

/** Files attached to one record (or all the person may see), newest first. Active documents only; see search.ts for the full library. */
export async function listFiles(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'document.view');
  const q = parseOrThrow(fileListSchema, query);
  if (q.resourceType) {
    const rule = RESOURCES[q.resourceType];
    if (!rule) throw Errors.validation({ resourceType: 'Unsupported resource type.' });
    requirePermission(ctx, rule.view);
  }
  return withTenant(ctx.business.id, async (tx) => {
    const where = {
      AND: [
        ...(await visibleFilesWhere(tx, ctx)),
        { status: 'ACTIVE' as const, isCurrent: true },
        ...(q.resourceType ? [{ resourceType: q.resourceType }] : []),
        ...(q.resourceId ? [{ resourceId: q.resourceId }] : []),
        ...(q.category ? [{ category: q.category }] : []),
      ],
    };
    const [total, rows] = await seq([
      tx.file.count({ where }),
      tx.file.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: await presentFiles(tx, ctx.business.id, rows), meta: pageMeta(q.page, q.pageSize, total) };
  });
}



export async function getFile(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'document.view');
  return withTenant(ctx.business.id, async (tx) => {
    const row = await loadFile(tx, ctx, id, 'view');
    const [view] = await presentFiles(tx, ctx.business.id, [row]);
    const versions = row.versionGroupId ? await tx.file.findMany({ where: { businessId: ctx.business.id, versionGroupId: row.versionGroupId, status: { not: 'DELETED' } }, orderBy: { version: 'desc' } }) : [row];
    return {
      file: view!,
      versions: await presentFiles(tx, ctx.business.id, versions),
      categoryLabel: (BUILTIN_CATEGORIES as Record<string, string>)[row.category] ?? row.category,
      can: {
        download: can(ctx, 'document.download'), edit: can(ctx, 'document.edit'), delete: can(ctx, 'document.delete') && !row.isFinancial,
        share: can(ctx, 'document.share') && (!row.resourceType || !!RESOURCES[row.resourceType]?.customerShareable),
      },
    };
  });
}

// ───────── bytes ─────────

export type OpenPurpose = 'preview' | 'download' | 'thumbnail';

/**
 * Authorise and open a file. Returns a stream; the route adds the hardening headers. A file from another business is simply
 * "not found". Preview and download are audited; thumbnails (a gallery loads dozens) are not.
 */
export async function openFile(ctx: BusinessContext, id: string, purpose: OpenPurpose = 'preview') {
  requirePermission(ctx, 'document.view');
  requirePermission(ctx, 'document.download');
  const row = await withTenant(ctx.business.id, async (tx) => {
    const r = await loadFile(tx, ctx, id, 'bytes', { statuses: ['ACTIVE', 'ARCHIVED', 'TRASHED'] });
    if (purpose !== 'thumbnail') {
      await recordAudit(tx, ctx.meta, { action: AuditActions.fileDownloaded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', resourceId: r.id, metadata: { purpose, name: r.originalName, attachedTo: r.resourceType, attachedId: r.resourceId } });
    }
    return r;
  });
  return streamOf(row, purpose === 'thumbnail');
}

export async function streamOf(row: FileRow, thumbnail = false) {
  const key = thumbnail && row.thumbnailKey ? row.thumbnailKey : row.storageKey;
  const isThumb = key !== row.storageKey;
  try {
    const { stream, size } = await getStorage().get(key);
    return { file: row, stream, size: size ?? (isThumb ? undefined : row.sizeBytes), mimeType: isThumb ? 'image/webp' : row.mimeType, isThumbnail: isThumb };
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      logger.error({ fileId: row.id, storageKey: key }, 'file record exists but object is missing');
      throw Errors.notFound('File');
    }
    throw err;
  }
}

/** A short-lived link to one file for the signed-in person: for opening on another device or handing to a viewer that has no session. */
export async function createDownloadLink(ctx: BusinessContext, id: string, ttlSec = DEFAULT_TTL_SEC) {
  requirePermission(ctx, 'document.view');
  requirePermission(ctx, 'document.download');
  const row = await withTenant(ctx.business.id, (tx) => loadFile(tx, ctx, id, 'bytes'));
  const { token, expiresAt } = signFileLink({ f: row.id, b: ctx.business.id, u: ctx.user.id, s: 'staff', i: false }, ttlSec);
  return { url: appUrl(`/api/public/files/${token}`), path: `/api/public/files/${token}`, expiresAt };
}

/** Use a signed link. The file is looked up again, so the link dies with the file's availability or the person's access. */
export async function openSignedFile(token: string) {
  const p = verifyFileLink(token);
  if (p.s !== 'staff') throw Errors.notFound('File');
  const row = await withTenant(p.b, async (tx) => {
    const f = await tx.file.findFirst({ where: { id: p.f, businessId: p.b, status: { in: ['ACTIVE', 'ARCHIVED'] } } });
    if (!f) throw Errors.notFound('File');
    const m = await tx.membership.findFirst({
      where: { businessId: p.b, userId: p.u, status: 'ACTIVE', user: { status: 'ACTIVE' }, role: { permissions: { some: { permission: 'document.download' } } } },
      select: { id: true },
    });
    if (!m) throw Errors.notFound('File');
    await recordAudit(tx, undefined, { action: AuditActions.fileDownloaded, businessId: p.b, userId: p.u, resourceType: 'file', resourceId: f.id, metadata: { purpose: 'download', via: 'signed_link', name: f.originalName } });
    return f;
  });
  return streamOf(row);
}

// ───────── metadata, visibility, versions ─────────

const editSchema = z.object({
  displayName: z.string().trim().max(150).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  category: z.string().trim().min(1).max(60).optional(),
});

export async function updateFile(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'document.edit');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(editSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const row = await loadFile(tx, ctx, id, 'edit', { statuses: ['ACTIVE', 'ARCHIVED'] });
    if (d.category && d.category !== row.category) {
      if (row.isFinancial) throw Errors.conflict('The category of a financial document cannot be changed.');
      if (FINANCIAL_CATEGORIES.has(d.category) && !can(ctx, 'document.manage')) throw Errors.forbidden('Only people who manage documents can file something as a financial document.');
      await assertCategory(tx, ctx.business.id, d.category);
    }
    const data = {
      ...(d.displayName !== undefined ? { displayName: d.displayName || null } : {}),
      ...(d.description !== undefined ? { description: d.description || null } : {}),
      ...(d.category !== undefined ? { category: d.category } : {}),
    };
    if (!Object.keys(data).length) return toView(row);
    const after = await tx.file.update({ where: { id: row.id }, data });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.fileEdited, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', resourceId: row.id,
      before: { displayName: row.displayName, description: row.description, category: row.category }, after: { displayName: after.displayName, description: after.description, category: after.category },
    });
    return toView(after);
  });
}

/** Change who may see a file. Making it customer-visible is a deliberate act with its own permission; some files can never be shown to customers. */
export async function setFileVisibility(ctx: BusinessContext, id: string, visibility: unknown) {
  requirePermission(ctx, 'document.edit');
  assertCanWrite(ctx.subscription);
  const v = parseOrThrow(visibilitySchema, visibility);
  if (v === 'CUSTOMER') requirePermission(ctx, 'document.share');
  if (v === 'RESTRICTED') requirePermission(ctx, 'document.view_restricted');
  return withTenant(ctx.business.id, async (tx) => {
    const row = await loadFile(tx, ctx, id, 'edit', { statuses: ['ACTIVE', 'ARCHIVED'] });
    if (row.visibility === v) return toView(row);
    if (row.visibility === 'CUSTOMER') requirePermission(ctx, 'document.share'); // taking something back from a customer is also a sharing decision
    if (v === 'CUSTOMER') {
      const rule = row.resourceType ? RESOURCES[row.resourceType] : undefined;
      if (!rule || !rule.customerShareable) throw Errors.validation({ visibility: 'Files on this kind of record can never be shown to customers.' });
      if (row.status !== 'ACTIVE') throw Errors.conflict('Only an active document can be shared with a customer.');
    }
    const after = await tx.file.update({ where: { id: row.id }, data: { visibility: v } });
    // A job photo carries its own visibility flag; the two always agree.
    if (row.resourceType === 'job') await tx.jobPhoto.updateMany({ where: { fileId: row.id, businessId: ctx.business.id }, data: { visibility: v === 'CUSTOMER' ? 'CUSTOMER' : 'INTERNAL' } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.fileVisibilityChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'file', resourceId: row.id, before: { visibility: row.visibility }, after: { visibility: v }, metadata: { attachedTo: row.resourceType, attachedId: row.resourceId } });
    return toView(after);
  });
}

/** Upload a replacement; the old one stays as an earlier version. Generated financial documents are never replaced this way. */
export async function uploadNewVersion(ctx: BusinessContext, id: string, upload: { data: Buffer; filename: string }) {
  requirePermission(ctx, 'document.upload');
  requirePermission(ctx, 'document.edit');
  assertCanWrite(ctx.subscription);
  const prev = await withTenant(ctx.business.id, async (tx) => {
    const row = await loadFile(tx, ctx, id, 'edit', { statuses: ['ACTIVE'] });
    if (row.isFinancial || row.source === 'GENERATED') throw Errors.conflict('A generated document cannot be replaced by an upload. Generate it again from its record instead.');
    if (!row.isCurrent) throw Errors.conflict('This is an earlier version. Replace the current version instead.');
    return row;
  });
  const settings = await withTenant(ctx.business.id, (tx) => loadDocumentSettings(tx, ctx.business.id));
  if (upload.data.length === 0) throw Errors.validation({ file: 'The file is empty.' });
  if (upload.data.length > settings.effectiveMaxUploadMb * 1024 * 1024) throw Errors.tooLarge(settings.effectiveMaxUploadMb);
  const filename = sanitizeFilename(upload.filename);
  const detected = detectFileType(upload.data, filename);
  if (!detected) throw Errors.unsupportedMedia('Allowed files: photos (JPG, PNG, WebP, GIF, HEIC), PDF, Word, Excel, CSV and text.');
  await assertDecodableImage(upload.data, detected.mime);
  const scan = await scanUpload(upload.data, detected.mime);
  if (!scan.ok) throw scan.failure.kind === 'flagged' ? Errors.unsupportedMedia(`This file was refused: ${scan.failure.reason}`) : new AppError('BAD_REQUEST', 503, 'Files cannot be checked right now, so uploads are paused. Please try again in a few minutes.');
  const file = await storeFile({
    businessId: ctx.business.id, actorId: ctx.user.id, meta: ctx.meta, data: upload.data, filename, mime: detected.mime, ext: detected.ext, resourceType: prev.resourceType, resourceId: prev.resourceId,
    category: prev.category, visibility: prev.visibility, description: prev.description, displayName: prev.displayName, source: 'UPLOAD', versionOf: prev.id, scan: scan.outcome,
  });
  return toView(file);
}

export async function listVersions(ctx: BusinessContext, id: string) {
  const d = await getFile(ctx, id);
  return d.versions;
}
