import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { withTenant } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertWithinLimit, loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { sha256Hex } from '@/server/security/crypto';
import { getStorage } from '@/server/storage';
import type { RequestMeta } from '@/server/context';
import type { DocumentVisibility } from '@/generated/prisma/client';
import { assertCategory, FINANCIAL_CATEGORIES } from './categories';
import { RESOURCES } from './registry';
import type { ScanOutcome } from './scan';
import { loadDocumentSettings } from './settings';
import { storeThumbnail } from './thumbs';

/**
 * The one place a file row and its stored object are created. Uploads and generated documents (PDFs) both come through here, so
 * there is exactly one document store, one set of tenant/ownership checks, one numbering of versions and one audit trail.
 *
 * Order matters: the object is written INSIDE the database transaction, so if storing fails the row is rolled back, and if the
 * commit fails the object is removed again. A file row therefore never exists without its object, and an object never lingers
 * without a row.
 */
export interface StoreInput {
  businessId: string;
  actorId: string | null;
  meta?: RequestMeta;
  data: Buffer;
  filename: string;
  mime: string;
  ext: string;
  resourceType?: string | null;
  resourceId?: string | null;
  category?: string;
  visibility?: DocumentVisibility;
  description?: string | null;
  displayName?: string | null;
  source?: 'UPLOAD' | 'GENERATED';
  generatedKind?: string;
  generatedRef?: string | null;
  /** The earlier file this one replaces (a new version of it). */
  versionOf?: string;
  scan?: ScanOutcome;
  /** Generated documents are not blocked by the storage allowance (they are records the business needs), but still count toward it. */
  enforceStorageLimit?: boolean;
  /** Extra audit metadata. */
  auditExtra?: Record<string, unknown>;
}

const lockKey = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
};

import type { FileRow } from './access';

export async function storeFile(input: StoreInput): Promise<FileRow> {
  const { businessId } = input;
  const storageKey = `${businessId}/${new Date().getUTCFullYear()}/${randomUUID()}`;
  const storage = getStorage();
  const id = randomUUID();
  const generated = input.source === 'GENERATED';

  const row = await withTenant(businessId, async (tx) => {
    let customerId: string | null = null;
    let locationId: string | null = null;
    let category = input.category;
    let visibility = input.visibility;
    if (input.resourceType && input.resourceId) {
      const rule = RESOURCES[input.resourceType];
      if (!rule) throw Errors.validation({ resourceType: 'Unsupported resource type.' });
      const owner = await rule.owner(tx, businessId, input.resourceId);
      if (!owner) throw Errors.notFound('Record');
      customerId = owner.customerId ?? null;
      locationId = owner.locationId ?? null;
      category ??= rule.defaultCategory;
      visibility ??= rule.defaultVisibility ?? 'INTERNAL';
      if (!rule.customerShareable && visibility === 'CUSTOMER') throw Errors.validation({ visibility: 'Files on this kind of record can never be shown to customers.' });
    }
    category ??= 'OTHER';
    visibility ??= 'INTERNAL';
    await assertCategory(tx, businessId, category);

    if (input.enforceStorageLimit !== false) {
      const sub = await loadEffectiveSubscription(tx, businessId);
      await assertWithinLimit(tx, businessId, sub, 'storage', input.data.length);
    }

    // Versioning: a new file that replaces an earlier one joins its version group.
    let version = 1;
    let versionGroupId: string | null = generated ? id : null;
    let previous: FileRow | null = null;
    if (input.versionOf) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(`ver:${businessId}:${input.versionOf}`)})`;
      previous = await tx.file.findFirst({ where: { id: input.versionOf, businessId } });
      if (!previous) throw Errors.notFound('File');
      versionGroupId = previous.versionGroupId ?? previous.id;
      const latest = await tx.file.aggregate({ where: { businessId, versionGroupId }, _max: { version: true } });
      version = Math.max(latest._max.version ?? previous.version, previous.version) + 1;
      if (!previous.versionGroupId) await tx.file.update({ where: { id: previous.id }, data: { versionGroupId } });
      await tx.file.updateMany({ where: { businessId, versionGroupId, isCurrent: true }, data: { isCurrent: false } });
    }

    const settings = await loadDocumentSettings(tx, businessId);
    const isFinancial = generated && FINANCIAL_CATEGORIES.has(category);
    const retainUntil = isFinancial ? new Date(Date.now() + settings.financialRetentionYears * 365.25 * 86_400_000) : null;

    const file = await tx.file.create({
      data: {
        id, businessId, uploadedById: input.actorId, storageKey, originalName: input.filename, mimeType: input.mime, sizeBytes: input.data.length, sha256: sha256Hex(input.data),
        resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null,
        displayName: input.displayName ?? null, extension: input.ext, description: input.description ?? null, category, visibility, version, versionGroupId, isCurrent: true,
        source: generated ? 'GENERATED' : 'UPLOAD', generatedKind: generated ? (input.generatedKind ?? 'document') : null, generatedRef: generated ? (input.generatedRef ?? null) : null,
        locationId, customerId, scanStatus: input.scan?.scanStatus ?? 'NOT_SCANNED', scannedAt: input.scan ? new Date() : null,
        isFinancial, retainUntil,
      },
    });
    // The object goes in inside the transaction: a storage failure rolls the row back.
    await storage.put(storageKey, input.data, { contentType: input.mime });
    await recordAudit(tx, input.meta, {
      action: previous ? AuditActions.fileVersioned : generated ? AuditActions.documentGenerated : AuditActions.fileUploaded,
      businessId, userId: input.actorId, resourceType: 'file', resourceId: file.id,
      metadata: {
        name: input.filename, mime: input.mime, size: file.sizeBytes, attachedTo: input.resourceType ?? null, attachedId: input.resourceId ?? null, category, visibility, version,
        ...(previous ? { replaces: previous.id } : {}), ...(generated ? { kind: input.generatedKind } : {}), ...(input.scan ? { scan: input.scan.engines.join('+') } : {}), ...input.auditExtra,
      },
    });
    return file;
  }).catch(async (err) => {
    // If the commit failed after the object was written, do not leave an orphan behind.
    await storage.delete(storageKey).catch((e) => logger.warn({ err: String(e), storageKey }, 'orphan cleanup failed'));
    throw err;
  });

  // A thumbnail is a convenience: made after the commit, and its absence is never an error.
  const thumb = await storeThumbnail(businessId, input.data, input.mime);
  if (thumb) {
    await withTenant(businessId, (tx) => tx.file.update({ where: { id: row.id }, data: { thumbnailKey: thumb } })).catch(async () => { await storage.delete(thumb).catch(() => {}); });
    return { ...row, thumbnailKey: thumb };
  }
  return row;
}

/** Reject an image that has the right first bytes but is not actually a decodable picture (truncated, or a disguised file). */
export async function assertDecodableImage(data: Buffer, mime: string): Promise<void> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) return;
  try {
    const meta = await sharp(data, { limitInputPixels: 100_000_000, failOn: 'error' }).metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
  } catch {
    throw Errors.unsupportedMedia('That image could not be read. It may be damaged. Try taking or exporting it again.');
  }
}
