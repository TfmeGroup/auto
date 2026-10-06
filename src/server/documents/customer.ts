import { Errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { z } from 'zod';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant } from '@/server/db/client';
import { createDocumentLink, withLink } from '@/server/finance/links';
import { requirePermission } from '@/server/permissions/authorize';
import { assertCanWrite } from '@/server/billing/subscriptions';
import type { BusinessContext } from '@/server/context';
import { visibleLocationIds, locationWhere } from '@/server/workshop/people';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { JOB_STATUS_LABEL, type JobStatus } from '@/server/jobcards/transitions';
import { getStorage } from '@/server/storage';
import { vehicleLabel } from '@/server/vehicles/service';
import { seq, type Tx } from '@/server/db/client';
import type { RequestMeta } from '@/server/context';
import { streamOf } from '@/server/files/service';

/**
 * The customer's view of their job, behind the private link they were sent. Everything is selected by explicit whitelist:
 *   - files appear only if their visibility is CUSTOMER (set by a person; never inferred from the kind of record) and they are active;
 *   - they must belong to THIS job, or to a quote or invoice of this job;
 *   - internal notes, costs, supplier or employee documents, trashed or archived files are never selected, so they cannot leak.
 * A link opens one job in one business and nothing else; every file fetch re-checks all of this.
 */
const ATTACHED_TO_JOB = async (tx: Tx, businessId: string, jobId: string) => {
  const [quotes, invoices] = await seq([
    tx.quote.findMany({ where: { businessId, jobId }, select: { id: true } }),
    tx.invoice.findMany({ where: { businessId, jobId, finalisedAt: { not: null } }, select: { id: true } }),
  ]);
  return [
    { resourceType: 'job', resourceId: jobId },
    ...quotes.map((q) => ({ resourceType: 'quote', resourceId: q.id })),
    ...invoices.map((i) => ({ resourceType: 'invoice', resourceId: i.id })),
  ];
};

async function sharedFiles(tx: Tx, businessId: string, jobId: string) {
  const where = await ATTACHED_TO_JOB(tx, businessId, jobId);
  return tx.file.findMany({ where: { businessId, status: 'ACTIVE', visibility: 'CUSTOMER', isCurrent: true, OR: where }, orderBy: { createdAt: 'desc' }, take: 100 });
}

export async function getPublicJob(token: string, meta: RequestMeta) {
  return withLink(token, 'JOB', async (tx, link) => {
    const businessId = link.businessId;
    const job = await tx.jobCard.findFirst({ where: { id: link.documentId, businessId } });
    if (!job) throw Errors.notFound('Job');
    const [business, customer, vehicle, notes, files, photos] = await seq([
      tx.business.findUniqueOrThrow({ where: { id: businessId } }),
      tx.customer.findFirstOrThrow({ where: { id: job.customerId, businessId }, select: { name: true } }),
      tx.vehicle.findFirstOrThrow({ where: { id: job.vehicleId, businessId } }),
      tx.jobNote.findMany({ where: { jobId: job.id, businessId, archivedAt: null, visibility: 'CUSTOMER' }, orderBy: { createdAt: 'desc' }, take: 20 }),
      sharedFiles(tx, businessId, job.id),
      tx.jobPhoto.findMany({ where: { jobId: job.id, businessId, archivedAt: null, visibility: 'CUSTOMER' }, select: { fileId: true, description: true, category: true } }),
    ]);
    const photoIds = new Map(photos.map((p) => [p.fileId, p]));
    const images = files.filter((f) => f.mimeType.startsWith('image/'));
    await recordAudit(tx, meta, { action: AuditActions.fileDownloaded, businessId, userId: null, resourceType: 'job', resourceId: job.id, metadata: { via: 'customer_link', purpose: 'job_page', linkId: link.id } }).catch(() => {});
    return {
      business: {
        name: business.tradingName ?? business.name, phone: business.phone, email: business.email, hasLogo: !!business.logoFileId, locale: business.locale, timezone: business.timezone,
        address: [business.addressLine1, business.addressLine2, business.city, business.province, business.postalCode].filter(Boolean).join(', ') || null,
      },
      customer: { name: customer.name },
      vehicle: { label: vehicleLabel(vehicle) },
      job: { number: job.jobNumber, status: job.status, statusLabel: JOB_STATUS_LABEL[job.status as JobStatus] ?? job.status, openedAt: job.openedAt, completedAt: job.completedAt, estimatedCompletionAt: ['COMPLETED', 'CANCELLED'].includes(job.status) ? null : job.estimatedCompletionAt },
      updates: notes.map((n) => ({ at: n.createdAt, body: n.body })),
      photos: images.map((f) => ({ id: f.id, caption: photoIds.get(f.id)?.description ?? f.description ?? null, takenAt: f.createdAt, thumbnail: !!f.thumbnailKey })),
      documents: files.filter((f) => !f.mimeType.startsWith('image/')).map((f) => ({ id: f.id, name: f.displayName || f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, createdAt: f.createdAt, kind: f.generatedKind })),
    };
  });
}

/** One shared file, for the customer holding the link. Anything not explicitly shared is "not found". */
export async function openPublicJobFile(token: string, fileId: string, meta: RequestMeta, opts: { thumbnail?: boolean } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(fileId)) throw Errors.notFound('File');
  const row = await withLink(token, 'JOB', async (tx, link) => {
    const allowed = await ATTACHED_TO_JOB(tx, link.businessId, link.documentId);
    const f = await tx.file.findFirst({ where: { id: fileId, businessId: link.businessId, status: 'ACTIVE', visibility: 'CUSTOMER', OR: allowed } });
    if (!f) throw Errors.notFound('File');
    if (!opts.thumbnail) await recordAudit(tx, meta, { action: AuditActions.fileDownloaded, businessId: link.businessId, userId: null, resourceType: 'file', resourceId: f.id, metadata: { via: 'customer_link', purpose: 'download', name: f.originalName, linkId: link.id } });
    return f;
  });
  return streamOf(row, !!opts.thumbnail);
}

export async function getPublicJobLogo(token: string) {
  const f = await withLink(token, 'JOB', async (tx, link) => {
    const b = await tx.business.findUniqueOrThrow({ where: { id: link.businessId }, select: { logoFileId: true } });
    if (!b.logoFileId) throw Errors.notFound('Logo');
    const file = await tx.file.findFirst({ where: { id: b.logoFileId, businessId: link.businessId, status: { not: 'DELETED' } } });
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType)) throw Errors.notFound('Logo');
    return file;
  });
  try {
    const { stream, size } = await getStorage().get(f.storageKey);
    return { stream, size: size ?? f.sizeBytes, mime: f.mimeType };
  } catch (err) {
    logger.warn({ err: String(err) }, 'job page logo unavailable');
    throw Errors.notFound('Logo');
  }
}

/**
 * A person at the workshop creates a private link to the customer's job page (to read to a customer over the phone, or paste into a
 * message). Sharing is a deliberate act with its own permission. The link shows only what has been marked for the customer.
 */
export async function createJobCustomerLink(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'document.share');
  requirePermission(ctx, 'job.view');
  assertCanWrite(ctx.subscription);
  const jobId = parseOrThrow(uuidSchema, id);
  void z;
  return withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const job = await tx.jobCard.findFirst({ where: { id: jobId, businessId: ctx.business.id, ...locationWhere(scope) }, select: { id: true, jobNumber: true } });
    if (!job) throw Errors.notFound('Job');
    const link = await createDocumentLink(tx, ctx.business.id, 'JOB', jobId, ctx.user.id);
    await recordAudit(tx, ctx.meta, { action: AuditActions.fileVisibilityChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, metadata: { customerLinkCreated: true, jobNumber: job.jobNumber } });
    return { url: link.url };
  });
}
