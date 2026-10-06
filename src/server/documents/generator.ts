import { z } from 'zod';
import { AppError, Errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, type Db, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { creditNotePdfModel, invoicePdfModel, quotePdfModel, receiptPdfModel } from '@/server/finance/documents';
import { renderDocumentPdf } from '@/server/finance/pdf';
import { RESOURCES } from '@/server/files/registry';
import { storeFile } from '@/server/files/store';
import type { FileRow } from '@/server/files/access';
import { purchaseOrderPdfModel } from '@/server/inventory/po-pdf';
import { enqueue } from '@/server/jobs/queue';
import { JobTypes } from '@/server/jobs/types';
import { notifyInApp } from '@/server/notifications/service';
import { requirePermission } from '@/server/permissions/authorize';
import type { Permission } from '@/server/permissions/catalog';
import type { BusinessContext, RequestMeta } from '@/server/context';
import { visibleLocationIds } from '@/server/workshop/people';
import { inspectionReportModel, jobSummaryModel } from './renderers';
import { renderReportPdf } from './report-pdf';
import type { DocumentVisibility } from '@/generated/prisma/client';

/**
 * Shared deterministic document generation. One service turns stored records into PDFs and files them in the ONE document store:
 *
 *   DocumentGenerator -> Quote / Invoice / Receipt / CreditNote / PurchaseOrder / InspectionReport / JobSummary renderers
 *
 * A generated document is a real file with a version. Asking for it again returns the stored copy (so an old quote or receipt never
 * silently re-renders with today's business details); making a NEW version is a controlled act (a business event, or someone with
 * document.manage giving a reason). Earlier versions are kept. The file row only exists once its object is really stored, and a
 * failed generation is recorded and retried, never half-created.
 */
export type DocKind = 'quote' | 'invoice' | 'receipt' | 'credit_note' | 'purchase_order' | 'inspection_report' | 'job_summary';

interface KindDef {
  resourceType: string;
  category: string;
  financial: boolean;
  /** Who may ask for it (on top of being able to see the record). */
  view: Permission;
  /** Shared with the customer when generated? (An explicit choice per kind, never inferred from the record.) */
  visibility: DocumentVisibility;
  /** A person may only ask for a fresh version when this is true (financial documents get new versions from business events). */
  freeRegenerate: boolean;
  render(businessId: string, entityId: string, opts: GenOptions): Promise<{ pdf: Buffer; filename: string; ref: string | null; locationId?: string | null }>;
}

export interface GenOptions {
  quoteVersion?: number;
  regenerate?: boolean;
  reason?: string;
}

async function modelOf<T>(businessId: string, fn: (tx: Tx) => Promise<T>) {
  return withTenant(businessId, fn);
}

export const KINDS: Record<DocKind, KindDef> = {
  quote: {
    resourceType: 'quote', category: 'QUOTE', financial: true, view: 'quote.view', visibility: 'CUSTOMER', freeRegenerate: false,
    async render(b, id, o) {
      const built = await modelOf(b, async (tx) => {
        const q = await tx.quote.findFirst({ where: { id, businessId: b }, select: { currentVersion: true } });
        if (!q) throw Errors.notFound('Quote');
        return { ...(await quotePdfModel(tx, b, id, o.quoteVersion ?? q.currentVersion)), version: o.quoteVersion ?? q.currentVersion };
      });
      return { pdf: await renderDocumentPdf(built.model), filename: built.filename, ref: `v${built.version}` };
    },
  },
  invoice: {
    resourceType: 'invoice', category: 'INVOICE', financial: true, view: 'invoice.view', visibility: 'CUSTOMER', freeRegenerate: false,
    async render(b, id) {
      const built = await modelOf(b, (tx) => invoicePdfModel(tx, b, id));
      return { pdf: await renderDocumentPdf(built.model), filename: built.filename, ref: null };
    },
  },
  receipt: {
    resourceType: 'receipt', category: 'RECEIPT', financial: true, view: 'payment.view', visibility: 'CUSTOMER', freeRegenerate: false,
    async render(b, id) {
      const built = await modelOf(b, (tx) => receiptPdfModel(tx, b, id));
      return { pdf: await renderDocumentPdf(built.model), filename: built.filename, ref: null };
    },
  },
  credit_note: {
    resourceType: 'credit_note', category: 'CREDIT_NOTE', financial: true, view: 'credit_note.view', visibility: 'CUSTOMER', freeRegenerate: false,
    async render(b, id) {
      const built = await modelOf(b, (tx) => creditNotePdfModel(tx, b, id));
      return { pdf: await renderDocumentPdf(built.model), filename: built.filename, ref: null };
    },
  },
  purchase_order: {
    resourceType: 'purchase_order', category: 'PURCHASE_ORDER', financial: false, view: 'inventory.view', visibility: 'INTERNAL', freeRegenerate: true,
    async render(b, id) {
      const m = await modelOf(b, async (tx) => {
        const po = await tx.purchaseOrder.findFirst({ where: { id, businessId: b }, select: { status: true } });
        if (!po) throw Errors.notFound('Purchase order');
        // Filed once the order is placed (before it is placed it is still a draft and can change).
        if (!['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status)) throw Errors.conflict('The purchase order is filed as a document once it has been placed.');
        return purchaseOrderPdfModel(tx, b, id, null);
      });
      return { pdf: await renderDocumentPdf(m), filename: `${m.number}.pdf`, ref: null };
    },
  },
  inspection_report: {
    resourceType: 'job', category: 'VEHICLE_INSPECTION', financial: false, view: 'job.view', visibility: 'INTERNAL', freeRegenerate: true,
    async render(b, id) {
      const r = await modelOf(b, (tx) => inspectionReportModel(tx, b, id));
      return { pdf: await renderReportPdf(r.model), filename: r.filename, ref: null, locationId: r.locationId };
    },
  },
  job_summary: {
    resourceType: 'job', category: 'JOB_DOCUMENT', financial: false, view: 'job.view', visibility: 'INTERNAL', freeRegenerate: true,
    async render(b, id) {
      const r = await modelOf(b, (tx) => jobSummaryModel(tx, b, id));
      return { pdf: await renderReportPdf(r.model), filename: r.filename, ref: null, locationId: r.locationId };
    },
  },
};

export const isDocKind = (k: string): k is DocKind => Object.prototype.hasOwnProperty.call(KINDS, k);

const currentOf = (tx: Tx, businessId: string, resourceType: string, resourceId: string, kind: string, ref: string | null) =>
  tx.file.findFirst({ where: { businessId, resourceType, resourceId, source: 'GENERATED', generatedKind: kind, generatedRef: ref, isCurrent: true, status: { in: ['ACTIVE', 'ARCHIVED'] } }, orderBy: { version: 'desc' } });

export interface Generated {
  file: FileRow;
  /** false = the stored copy was returned and nothing was made. */
  created: boolean;
}

/** The system-level core: no person involved. Stored copy if there is one (unless a new version is asked for), else render and store. */
export async function generateDocument(businessId: string, actorId: string | null, kind: DocKind, entityId: string, opts: GenOptions & { meta?: RequestMeta } = {}): Promise<Generated> {
  const def = KINDS[kind];
  const ownerRef = RESOURCES[def.resourceType]!;
  const refGuess = kind === 'quote' && opts.quoteVersion ? `v${opts.quoteVersion}` : null;

  // For a quote the reference (its version) is only known after looking the quote up, so resolve it before the lookup.
  let wantedRef = refGuess;
  if (kind === 'quote' && !wantedRef) {
    const q = await withTenant(businessId, (tx) => tx.quote.findFirst({ where: { id: entityId, businessId }, select: { currentVersion: true } }));
    if (!q) throw Errors.notFound('Quote');
    wantedRef = `v${q.currentVersion}`;
  }

  const existing = await withTenant(businessId, async (tx) => {
    if (!(await ownerRef.owner(tx, businessId, entityId))) throw Errors.notFound('Record');
    return currentOf(tx, businessId, def.resourceType, entityId, kind, wantedRef);
  });
  if (existing && !opts.regenerate) return { file: existing, created: false };

  const out = await def.render(businessId, entityId, { ...opts, quoteVersion: opts.quoteVersion ?? (wantedRef ? Number(wantedRef.slice(1)) : undefined) });
  try {
    const file = await storeFile({
      businessId, actorId, meta: opts.meta, data: out.pdf, filename: out.filename, mime: 'application/pdf', ext: 'pdf', resourceType: def.resourceType, resourceId: entityId, category: def.category,
      visibility: existing ? existing.visibility : def.visibility, source: 'GENERATED', generatedKind: kind, generatedRef: out.ref ?? wantedRef, versionOf: existing?.id, enforceStorageLimit: false,
      auditExtra: opts.reason ? { reason: opts.reason } : undefined,
    });
    if (kind === 'invoice') await withTenant(businessId, (tx) => tx.invoice.updateMany({ where: { id: entityId, businessId, pdfFileId: null }, data: { pdfFileId: file.id } }));
    return { file, created: true };
  } catch (err) {
    // A concurrent request stored the first version a moment ago: use theirs.
    if (typeof err === 'object' && err && 'code' in err && (err as { code?: string }).code === 'P2002') {
      const raced = await withTenant(businessId, (tx) => currentOf(tx, businessId, def.resourceType, entityId, kind, out.ref ?? wantedRef));
      if (raced) return { file: raced, created: false };
    }
    throw err;
  }
}

/**
 * Customer statements are made for a period and a closing balance, so each distinct statement is its own stored document
 * (the same period and balance asked for twice gives the stored one back).
 */
export async function storeStatementPdf(businessId: string, actorId: string | null, customerId: string, ref: string, filename: string, pdf: Buffer, meta?: RequestMeta): Promise<FileRow> {
  const existing = await withTenant(businessId, (tx) => currentOf(tx, businessId, 'statement', customerId, 'statement', ref));
  if (existing) return existing;
  try {
    return await storeFile({
      businessId, actorId, meta, data: pdf, filename, mime: 'application/pdf', ext: 'pdf', resourceType: 'statement', resourceId: customerId, category: 'STATEMENT', visibility: 'CUSTOMER',
      source: 'GENERATED', generatedKind: 'statement', generatedRef: ref, enforceStorageLimit: false,
    });
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && (err as { code?: string }).code === 'P2002') {
      const raced = await withTenant(businessId, (tx) => currentOf(tx, businessId, 'statement', customerId, 'statement', ref));
      if (raced) return raced;
    }
    throw err;
  }
}

// ───────── asked for by a person ─────────

const askSchema = z.object({ regenerate: z.coerce.boolean().default(false), reason: z.string().trim().max(300).optional(), quoteVersion: z.coerce.number().int().min(1).optional() });

/** A person asks for a document: they must be able to see the record; a new version needs a reason and the right permission. */
export async function ensureDocument(ctx: BusinessContext, kind: DocKind, id: string, input: unknown = {}): Promise<Generated> {
  const def = KINDS[kind];
  requirePermission(ctx, def.view);
  requirePermission(ctx, 'document.view');
  const entityId = parseOrThrow(uuidSchema, id);
  const o = parseOrThrow(askSchema, input ?? {});
  await assertRecordAccess(ctx, def, entityId);
  if (o.regenerate) {
    assertCanWrite(ctx.subscription);
    requirePermission(ctx, def.financial || !def.freeRegenerate ? 'document.manage' : 'document.upload');
    if (!o.reason || o.reason.length < 5) throw Errors.validation({ reason: 'Say why a new version is needed (a few words).' });
  } else if (ctx.subscription.canWrite === false) {
    // Read-only (expired) subscription: serve what is stored; making a new file is a write.
    const stored = await withTenant(ctx.business.id, (tx) => currentOf(tx, ctx.business.id, def.resourceType, entityId, kind, kind === 'quote' && o.quoteVersion ? `v${o.quoteVersion}` : null));
    if (stored) return { file: stored, created: false };
    throw Errors.subscriptionInactive();
  }
  try {
    return await generateDocument(ctx.business.id, ctx.user.id, kind, entityId, { quoteVersion: o.quoteVersion, regenerate: o.regenerate, reason: o.reason, meta: ctx.meta });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AppError' || 'status' in err)) throw err;
    await recordFailure(ctx.business.id, ctx.user.id, kind, entityId, err);
    throw new AppError('INTERNAL', 500, 'The document could not be created. Nothing was changed; please try again.');
  }
}

async function assertRecordAccess(ctx: BusinessContext, def: KindDef, entityId: string) {
  await withTenant(ctx.business.id, async (tx) => {
    const owner = await RESOURCES[def.resourceType]!.owner(tx, ctx.business.id, entityId);
    if (!owner) throw Errors.notFound('Record');
    if (owner.locationId) {
      const scope = await visibleLocationIds(tx, ctx);
      if (scope && !scope.includes(owner.locationId)) throw Errors.notFound('Record');
    }
  });
}

async function recordFailure(businessId: string, userId: string | null, kind: DocKind, entityId: string, err: unknown) {
  logger.error({ businessId, kind, entityId, err: String(err) }, 'document generation failed');
  await withTenant(businessId, async (tx) => {
    await recordAudit(tx, undefined, { action: AuditActions.documentGenerationFailed, businessId, userId, resourceType: KINDS[kind].resourceType, resourceId: entityId, metadata: { kind, error: String(err).slice(0, 300) } });
  }).catch(() => {});
}

// ───────── generation as a background job ─────────

export const GENERATION_MAX_ATTEMPTS = 4;

/** Queue a generation (idempotent per dedupeKey). Call inside the transaction of the business event that caused it. */
export async function enqueueGeneration(db: Db, businessId: string, kind: DocKind, entityId: string, opts: { dedupeKey: string; requestedById?: string | null; regenerate?: boolean; reason?: string; quoteVersion?: number }): Promise<boolean> {
  const made = await db.documentGeneration.createManyAndReturn({
    data: [{ businessId, kind, entityId, requestedById: opts.requestedById ?? null, dedupeKey: opts.dedupeKey }],
    skipDuplicates: true,
  });
  if (made.length === 0) return false; // this event already asked for it
  await enqueue(db, JobTypes.documentGenerate, { businessId, generationId: made[0]!.id, kind, entityId, regenerate: !!opts.regenerate, reason: opts.reason ?? null, quoteVersion: opts.quoteVersion ?? null }, {
    dedupeKey: `docgen:${made[0]!.id}`, businessId, maxAttempts: GENERATION_MAX_ATTEMPTS,
  });
  return true;
}

export interface GenerationPayload {
  businessId: string;
  generationId: string;
  kind: DocKind;
  entityId: string;
  regenerate: boolean;
  reason: string | null;
  quoteVersion: number | null;
}

/** The job handler: idempotent (a finished generation is skipped) and observable (the row says what happened). */
export async function runGenerationJob(p: GenerationPayload, attempt: number): Promise<void> {
  const row = await withTenant(p.businessId, (tx) => tx.documentGeneration.findFirst({ where: { id: p.generationId, businessId: p.businessId } }));
  if (!row || row.status === 'DONE') return;
  await withTenant(p.businessId, (tx) => tx.documentGeneration.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } }));
  try {
    const gen = await generateDocument(p.businessId, row.requestedById, p.kind, p.entityId, { regenerate: p.regenerate, reason: p.reason ?? undefined, quoteVersion: p.quoteVersion ?? undefined });
    await withTenant(p.businessId, async (tx) => {
      await tx.documentGeneration.update({ where: { id: row.id }, data: { status: 'DONE', fileId: gen.file.id, completedAt: new Date(), lastError: null } });
      if (row.requestedById) await notifyInApp(tx, { businessId: p.businessId, userId: row.requestedById, type: 'DOCUMENT_READY', title: 'Your document is ready', body: gen.file.displayName ?? gen.file.originalName, linkUrl: `/documents/${gen.file.id}` });
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const last = attempt >= GENERATION_MAX_ATTEMPTS;
    await withTenant(p.businessId, (tx) => tx.documentGeneration.update({ where: { id: row.id }, data: { lastError: message, ...(last ? { status: 'FAILED' as const } : {}) } })).catch(() => {});
    if (last) await recordFailure(p.businessId, row.requestedById, p.kind, p.entityId, err);
    throw err;
  }
}

/**
 * For business events (an invoice is issued, a receipt is made): try now so the stored copy exists immediately, and if that fails
 * hand the job to the queue to retry rather than lose it. Never throws: a failed PDF must not undo the financial action that caused it.
 */
export async function generateOrQueue(businessId: string, userId: string | null, kind: DocKind, entityId: string, opts: { dedupeKey: string; regenerate?: boolean; reason?: string; quoteVersion?: number }): Promise<string | null> {
  try {
    const g = await generateDocument(businessId, userId, kind, entityId, { regenerate: opts.regenerate, reason: opts.reason, quoteVersion: opts.quoteVersion });
    return g.file.id;
  } catch (err) {
    logger.warn({ businessId, kind, entityId, err: String(err) }, 'document generation failed inline; queued for retry');
    await withTenant(businessId, (tx) => enqueueGeneration(tx, businessId, kind, entityId, { ...opts, requestedById: userId })).catch((e) => logger.error({ err: String(e) }, 'could not queue document generation'));
    return null;
  }
}

/** Failed and pending generations, for people who manage documents. */
export async function listGenerations(ctx: BusinessContext, opts: { status?: 'QUEUED' | 'DONE' | 'FAILED' } = {}) {
  requirePermission(ctx, 'document.manage');
  return withTenant(ctx.business.id, (tx) => tx.documentGeneration.findMany({ where: { businessId: ctx.business.id, ...(opts.status ? { status: opts.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 }));
}

/** Try a failed generation again. */
export async function retryGeneration(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'document.manage');
  assertCanWrite(ctx.subscription);
  const genId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const g = await tx.documentGeneration.findFirst({ where: { id: genId, businessId: ctx.business.id } });
    if (!g) throw Errors.notFound('Document request');
    if (g.status !== 'FAILED') throw Errors.conflict('Only a failed request can be tried again.');
    const kind = g.kind as DocKind;
    if (!isDocKind(kind)) throw Errors.conflict('Unknown document type.');
    await tx.documentGeneration.update({ where: { id: g.id }, data: { status: 'QUEUED', attempts: 0, lastError: null } });
    await enqueue(tx, JobTypes.documentGenerate, { businessId: ctx.business.id, generationId: g.id, kind, entityId: g.entityId, regenerate: false, reason: null, quoteVersion: null }, { dedupeKey: `docgen:${g.id}:retry:${Date.now()}`, businessId: ctx.business.id, maxAttempts: GENERATION_MAX_ATTEMPTS });
    return { id: g.id };
  });
}
