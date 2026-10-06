import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { requirePermission } from '@/server/permissions/authorize';
import { getStorage } from '@/server/storage';
import type { BusinessContext } from '@/server/context';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import { creditNotePdfModel, invoicePdfModel, quotePdfModel, receiptPdfModel } from './documents';
import { storedPdf } from '@/server/documents/serve';
import { withLink } from './links';
import { renderDocumentPdf } from './pdf';

/** Authorised ways to obtain a rendered PDF. Every PDF is rendered from stored records at the moment it is asked for. */

export interface PdfOut {
  pdf: Buffer;
  filename: string;
}

export async function getInvoicePdf(ctx: BusinessContext, id: string): Promise<PdfOut> {
  requirePermission(ctx, 'invoice.view');
  const invoiceId = parseOrThrow(uuidSchema, id);
  const built = await withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    if (!(await tx.invoice.count({ where: { id: invoiceId, businessId: ctx.business.id, ...locationWhere(scope) } }))) throw Errors.notFound('Invoice');
    return invoicePdfModel(tx, ctx.business.id, invoiceId);
  });
  return { pdf: await renderDocumentPdf(built.model), filename: built.filename };
}

export async function getQuotePdf(ctx: BusinessContext, id: string, version?: string): Promise<PdfOut> {
  requirePermission(ctx, 'quote.view');
  const quoteId = parseOrThrow(uuidSchema, id);
  const built = await withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    if (!(await tx.quote.count({ where: { id: quoteId, businessId: ctx.business.id, ...locationWhere(scope) } }))) throw Errors.notFound('Quote');
    return quotePdfModel(tx, ctx.business.id, quoteId, version ? Number(version) || undefined : undefined);
  });
  // A quote's PDF is rendered once per version and kept: reprinting it never picks up business details changed since.
  const stored = await storedPdf(ctx.business.id, ctx.user.id, 'quote', quoteId, { quoteVersion: version ? Number(version) || undefined : undefined, createIfMissing: ctx.subscription.canWrite });
  if (stored) return stored;
  return { pdf: await renderDocumentPdf(built.model), filename: built.filename };
}

export async function getCreditNotePdf(ctx: BusinessContext, id: string): Promise<PdfOut> {
  requirePermission(ctx, 'credit_note.view');
  const cnId = parseOrThrow(uuidSchema, id);
  const built = await withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    if (!(await tx.creditNote.count({ where: { id: cnId, businessId: ctx.business.id, invoice: locationWhere(scope) } }))) throw Errors.notFound('Credit note');
    return creditNotePdfModel(tx, ctx.business.id, cnId);
  });
  const stored = await storedPdf(ctx.business.id, ctx.user.id, 'credit_note', cnId, { createIfMissing: ctx.subscription.canWrite });
  if (stored) return stored;
  return { pdf: await renderDocumentPdf(built.model), filename: built.filename };
}

export async function getReceiptPdf(ctx: BusinessContext, id: string): Promise<PdfOut> {
  requirePermission(ctx, 'payment.view');
  const receiptId = parseOrThrow(uuidSchema, id);
  const built = await withTenant(ctx.business.id, async (tx) => {
    const r = await tx.receipt.findFirst({ where: { id: receiptId, businessId: ctx.business.id } });
    if (!r) throw Errors.notFound('Receipt');
    if (r.invoiceId) {
      const scope = await visibleLocationIds(tx, ctx);
      if (!(await tx.invoice.count({ where: { id: r.invoiceId, businessId: ctx.business.id, ...locationWhere(scope) } }))) throw Errors.notFound('Receipt');
    }
    return receiptPdfModel(tx, ctx.business.id, receiptId);
  });
  const stored = await storedPdf(ctx.business.id, ctx.user.id, 'receipt', receiptId, { createIfMissing: ctx.subscription.canWrite });
  if (stored) return stored;
  return { pdf: await renderDocumentPdf(built.model), filename: built.filename };
}

// ───────── customer links ─────────

export async function getPublicInvoicePdf(token: string): Promise<PdfOut> {
  const built = await withLink(token, 'INVOICE', async (tx, link) => {
    const inv = await tx.invoice.findFirst({ where: { id: link.documentId, businessId: link.businessId }, select: { finalisedAt: true } });
    if (!inv?.finalisedAt) throw Errors.notFound('Invoice');
    return invoicePdfModel(tx, link.businessId, link.documentId);
  });
  return { pdf: await renderDocumentPdf(built.model), filename: built.filename };
}

export async function getPublicQuotePdf(token: string): Promise<PdfOut> {
  const built = await withLink(token, 'QUOTE', async (tx, link) => {
    const q = await tx.quote.findFirst({ where: { id: link.documentId, businessId: link.businessId }, select: { status: true } });
    if (!q || q.status === 'CANCELLED') throw Errors.notFound('Quote');
    return { ...(await quotePdfModel(tx, link.businessId, link.documentId)), businessId: link.businessId, quoteId: link.documentId };
  });
  const stored = await storedPdf(built.businessId, null, 'quote', built.quoteId, { createIfMissing: true });
  if (stored) return stored;
  return { pdf: await renderDocumentPdf(built.model), filename: built.filename };
}

/** The business logo, for a customer's page. Only reachable with a valid link, and only the logo of that link's business. */
export async function getPublicLogo(token: string, kind: 'QUOTE' | 'INVOICE') {
  const file = await withLink(token, kind, async (tx, link) => {
    const b = await tx.business.findUniqueOrThrow({ where: { id: link.businessId }, select: { logoFileId: true } });
    if (!b.logoFileId) throw Errors.notFound('Logo');
    const f = await tx.file.findFirst({ where: { id: b.logoFileId, businessId: link.businessId, status: { not: 'DELETED' } } });
    if (!f || !['image/png', 'image/jpeg', 'image/webp'].includes(f.mimeType)) throw Errors.notFound('Logo');
    return f;
  });
  const { stream, size } = await getStorage().get(file.storageKey);
  return { stream, size: size ?? file.sizeBytes, mime: file.mimeType };
}
