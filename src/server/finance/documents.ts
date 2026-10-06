import { formatDate } from '@/lib/format';
import { logger } from '@/lib/logger';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { getStorage } from '@/server/storage';
import { vehicleLabel } from '@/server/vehicles/service';
import { renderDocumentPdf, renderStatementPdf, type PdfBusiness, type PdfDocumentModel, type PdfStatementModel } from './pdf';
import { businessSnapshot, customerSnapshot, loadFinanceSettings, type BusinessSnapshot, type CustomerSnapshot } from './common';

/**
 * Turns stored financial records into PDFs and files them in the shared document store (private, tenant-scoped, served only
 * through authorised endpoints). A PDF is always rendered from the stored rows of the record — never from anything a browser
 * sent. Issued invoices render from the business and customer details frozen at issue, so reprinting an old invoice years
 * later shows what it showed the day it was issued.
 */

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

export async function loadLogo(tx: Tx, businessId: string, logoFileId: string | null | undefined): Promise<PdfBusiness['logo']> {
  if (!logoFileId) return null;
  const f = await tx.file.findFirst({ where: { id: logoFileId, businessId, status: { not: 'DELETED' } } });
  if (!f || !['image/png', 'image/jpeg'].includes(f.mimeType)) return null;
  try {
    const { stream } = await getStorage().get(f.storageKey);
    return { bytes: await readAll(stream), kind: f.mimeType === 'image/png' ? 'png' : 'jpg' };
  } catch (err) {
    logger.warn({ err: String(err), businessId }, 'logo could not be read for a document');
    return null;
  }
}

async function pdfBusiness(tx: Tx, businessId: string, snap: BusinessSnapshot): Promise<PdfBusiness> {
  return {
    name: snap.name, tradingName: snap.tradingName, legalName: snap.legalName, registrationNumber: snap.registrationNumber, vatNumber: snap.vatNumber, phone: snap.phone, email: snap.email,
    website: snap.website, address: snap.address, currency: snap.currency, locale: snap.locale, logo: await loadLogo(tx, businessId, snap.logoFileId),
  };
}

/** The business's branding as it stands now, for documents that are not frozen at issue (job summaries, inspection reports, purchase orders). */
export async function currentBranding(tx: Tx, businessId: string): Promise<{ business: PdfBusiness; footer: string | null }> {
  const settings = await loadFinanceSettings(tx, businessId);
  const snap = await businessSnapshot(tx, businessId, settings);
  return { business: await pdfBusiness(tx, businessId, snap), footer: snap.footer ?? null };
}

const customerBlock = (c: CustomerSnapshot) => ({ name: c.name, lines: [c.contactName !== c.name ? `Attn: ${c.contactName}` : null, c.address, c.mobile, c.email, c.companyRegNumber ? `Reg: ${c.companyRegNumber}` : null, `Customer no: ${c.customerNumber}`].filter((v): v is string => !!v) });

async function liveSnapshots(tx: Tx, businessId: string, customerId: string, locationId?: string | null) {
  const settings = await loadFinanceSettings(tx, businessId);
  return { business: await businessSnapshot(tx, businessId, settings, locationId), customer: await customerSnapshot(tx, businessId, customerId), settings };
}

const fmtDate = (d: Date | null | undefined, snap: BusinessSnapshot) => (d ? formatDate(d, 'UTC', snap.locale) : '-');

async function vehicleRefs(tx: Tx, businessId: string, vehicleId: string | null, jobId: string | null, quoteId: string | null, extra: [string, string][] = []): Promise<[string, string][]> {
  const refs: [string, string][] = [];
  if (vehicleId) {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId } });
    if (v) { refs.push(['Vehicle', vehicleLabel(v)]); if (v.vin) refs.push(['VIN', v.vin]); if (v.mileageKm !== null) refs.push(['Odometer', `${v.mileageKm.toLocaleString('en-ZA')} km`]); }
  }
  if (jobId) { const j = await tx.jobCard.findFirst({ where: { id: jobId, businessId }, select: { jobNumber: true } }); if (j) refs.push(['Job', j.jobNumber]); }
  if (quoteId) { const q = await tx.quote.findFirst({ where: { id: quoteId, businessId }, select: { number: true } }); if (q) refs.push(['Quote', q.number]); }
  return [...refs, ...extra];
}

// ───────── Invoice ─────────

export async function invoicePdfModel(tx: Tx, businessId: string, invoiceId: string): Promise<{ model: PdfDocumentModel; filename: string; customerId: string }> {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, businessId }, include: { lines: { orderBy: { position: 'asc' } } } });
  if (!inv) throw Errors.notFound('Invoice');
  const live = inv.businessSnapshot && inv.customerSnapshot ? null : await liveSnapshots(tx, businessId, inv.customerId);
  const bSnap = (inv.businessSnapshot ?? live!.business) as BusinessSnapshot;
  const cSnap = (inv.customerSnapshot ?? live!.customer) as CustomerSnapshot;
  const draft = inv.status === 'DRAFT';
  const taxInvoice = inv.vatRegistered && !!bSnap.vatNumber;
  const stamp = inv.status === 'CANCELLED' ? 'CANCELLED' : inv.status === 'WRITTEN_OFF' ? 'WRITTEN OFF' : draft ? 'DRAFT' : inv.status === 'PAID' ? 'PAID' : inv.paidCents + inv.creditAppliedCents > 0 ? 'PART PAID' : null;
  const sections: PdfDocumentModel['sections'] = [];
  if (!draft && inv.outstandingCents > 0 && bSnap.paymentInstructions) sections.push({ heading: 'How to pay', text: bSnap.paymentInstructions });
  if (inv.customerNotes) sections.push({ heading: 'Notes', text: inv.customerNotes });
  if (inv.terms) sections.push({ heading: 'Terms and conditions', text: inv.terms });
  const totals: PdfDocumentModel['totals'] = [{ label: 'Subtotal', cents: inv.subtotalCents }];
  if (inv.discountCents > 0) totals.push({ label: 'Discount', cents: -inv.discountCents }, { label: 'Subtotal after discount', cents: inv.taxableCents });
  if (inv.vatRegistered) totals.push({ label: `VAT (${(inv.vatRateBps / 100).toFixed(inv.vatRateBps % 100 ? 2 : 0)}%)`, cents: inv.vatCents });
  totals.push({ label: 'Total', cents: inv.totalCents, bold: true });
  if (!draft) {
    if (inv.paidCents > 0) totals.push({ label: 'Paid', cents: -inv.paidCents });
    if (inv.creditAppliedCents > 0) totals.push({ label: 'Credit applied', cents: -inv.creditAppliedCents });
    if (inv.creditNotedCents > 0) totals.push({ label: 'Credit notes', cents: -inv.creditNotedCents });
    if (inv.writtenOffCents > 0) totals.push({ label: 'Written off', cents: -inv.writtenOffCents });
    totals.push({ label: 'Amount outstanding', cents: inv.outstandingCents, bold: true, accent: true });
  }
  const facts: [string, string][] = draft ? [['Status', 'Draft - not yet issued']] : [['Invoice date', fmtDate(inv.invoiceDate, bSnap)], ['Due date', fmtDate(inv.dueDate, bSnap)]];
  return {
    customerId: inv.customerId,
    filename: `${inv.number ?? 'invoice-draft'}.pdf`,
    model: {
      title: taxInvoice ? 'TAX INVOICE' : 'INVOICE', number: inv.number ?? 'DRAFT', facts, stamp, business: await pdfBusiness(tx, businessId, bSnap), billTo: customerBlock(cSnap),
      references: await vehicleRefs(tx, businessId, inv.vehicleId, inv.jobId, inv.quoteId, inv.paymentTermsDays > 0 && !draft ? [['Payment terms', `${inv.paymentTermsDays} days`]] : []),
      lines: inv.lines, totals, sections, footer: bSnap.footer,
    },
  };
}

// ───────── Quote ─────────

export async function quotePdfModel(tx: Tx, businessId: string, quoteId: string, version?: number): Promise<{ model: PdfDocumentModel; filename: string }> {
  const q = await tx.quote.findFirst({ where: { id: quoteId, businessId } });
  if (!q) throw Errors.notFound('Quote');
  const v = await tx.quoteVersion.findFirst({ where: { quoteId, businessId, version: version ?? q.currentVersion }, include: { lines: { orderBy: { position: 'asc' } } } });
  if (!v) throw Errors.notFound('Version');
  const { business, customer } = await liveSnapshots(tx, businessId, q.customerId, q.locationId);
  const totals: PdfDocumentModel['totals'] = [{ label: 'Subtotal', cents: v.subtotalCents }];
  if (v.discountCents > 0) totals.push({ label: 'Discount', cents: -v.discountCents }, { label: 'Subtotal after discount', cents: v.taxableCents });
  if (v.vatRegistered) totals.push({ label: `VAT (${(v.vatRateBps / 100).toFixed(v.vatRateBps % 100 ? 2 : 0)}%)`, cents: v.vatCents });
  totals.push({ label: 'Total', cents: v.totalCents, bold: true, accent: true });
  const sections: PdfDocumentModel['sections'] = [];
  if (v.description) sections.push({ heading: 'Description', text: v.description });
  if (v.customerNotes) sections.push({ heading: 'Notes', text: v.customerNotes });
  if (v.terms) sections.push({ heading: 'Terms and conditions', text: v.terms });
  return {
    filename: `${q.number}-v${v.version}.pdf`,
    model: {
      title: 'QUOTE', number: `${q.number} (v${v.version})`, facts: [['Date', fmtDate(v.quoteDate, business)], ['Valid until', fmtDate(v.validUntil, business)]],
      stamp: q.status === 'APPROVED' || q.status === 'CONVERTED' ? 'APPROVED' : q.status === 'EXPIRED' ? 'EXPIRED' : q.status === 'CANCELLED' ? 'CANCELLED' : null,
      business: await pdfBusiness(tx, businessId, business), billTo: customerBlock(customer), references: await vehicleRefs(tx, businessId, q.vehicleId, q.jobId, null, v.title ? [['Subject', v.title]] : []),
      lines: v.lines, totals, sections, footer: business.footer,
    },
  };
}

// ───────── Credit note ─────────

export async function creditNotePdfModel(tx: Tx, businessId: string, id: string): Promise<{ model: PdfDocumentModel; filename: string }> {
  const cn = await tx.creditNote.findFirst({ where: { id, businessId }, include: { lines: { orderBy: { position: 'asc' } }, invoice: { select: { number: true, businessSnapshot: true, customerSnapshot: true } } } });
  if (!cn) throw Errors.notFound('Credit note');
  const live = await liveSnapshots(tx, businessId, cn.customerId);
  const bSnap = (cn.invoice.businessSnapshot ?? live.business) as BusinessSnapshot;
  const cSnap = (cn.invoice.customerSnapshot ?? live.customer) as CustomerSnapshot;
  const totals: PdfDocumentModel['totals'] = [{ label: 'Subtotal', cents: cn.subtotalCents }];
  if (cn.discountCents > 0) totals.push({ label: 'Discount', cents: -cn.discountCents });
  if (cn.vatRegistered) totals.push({ label: `VAT (${(cn.vatRateBps / 100).toFixed(cn.vatRateBps % 100 ? 2 : 0)}%)`, cents: cn.vatCents });
  totals.push({ label: 'Total credited', cents: cn.totalCents, bold: true, accent: true });
  if (cn.status === 'ISSUED') {
    if (cn.appliedCents > 0) totals.push({ label: 'Applied to the invoice', cents: cn.appliedCents });
    if (cn.creditedCents > 0) totals.push({ label: 'Added to your account credit', cents: cn.creditedCents });
  }
  const sections: PdfDocumentModel['sections'] = [{ heading: 'Reason', text: cn.reason }];
  if (cn.notes) sections.push({ heading: 'Notes', text: cn.notes });
  return {
    filename: `${cn.number ?? 'credit-note-draft'}.pdf`,
    model: {
      title: cn.vatRegistered ? 'TAX CREDIT NOTE' : 'CREDIT NOTE', number: cn.number ?? 'DRAFT', facts: [['Date', cn.issuedAt ? fmtDate(cn.issuedAt, bSnap) : 'Not yet issued'], ['Against invoice', cn.invoice.number ?? '-']],
      stamp: cn.status === 'DRAFT' ? 'DRAFT' : cn.status === 'CANCELLED' ? 'CANCELLED' : null, business: await pdfBusiness(tx, businessId, bSnap), billTo: customerBlock(cSnap),
      references: await vehicleRefs(tx, businessId, cn.vehicleId, null, null), lines: cn.lines, totals, sections, footer: bSnap.footer,
    },
  };
}

// ───────── Receipt ─────────

export async function receiptPdfModel(tx: Tx, businessId: string, receiptId: string): Promise<{ model: PdfDocumentModel; filename: string }> {
  const r = await tx.receipt.findFirst({ where: { id: receiptId, businessId }, include: { payment: true } });
  if (!r) throw Errors.notFound('Receipt');
  const inv = r.invoiceId ? await tx.invoice.findFirst({ where: { id: r.invoiceId, businessId }, select: { number: true, businessSnapshot: true, customerSnapshot: true, vehicleId: true, jobId: true } }) : null;
  const live = await liveSnapshots(tx, businessId, r.customerId);
  const bSnap = (inv?.businessSnapshot ?? live.business) as BusinessSnapshot;
  const cSnap = (inv?.customerSnapshot ?? live.customer) as CustomerSnapshot;
  const methodLabel = { CARD: 'Card', EFT: 'EFT', CASH: 'Cash', ONLINE: 'Online payment', OTHER: 'Other' }[r.method];
  const totals: PdfDocumentModel['totals'] = [{ label: 'Amount received', cents: r.amountCents, bold: true, accent: true }];
  if (r.invoiceTotalCents !== null) totals.push({ label: 'Invoice total', cents: r.invoiceTotalCents });
  if (r.invoicePaidCents !== null) totals.push({ label: 'Paid to date', cents: r.invoicePaidCents });
  if (r.remainingCents !== null) totals.push({ label: 'Remaining balance', cents: r.remainingCents, bold: true });
  return {
    filename: `${r.number}.pdf`,
    model: {
      title: 'RECEIPT', number: r.number, variant: 'simple', stamp: null,
      facts: [['Date', fmtDate(r.issuedAt, bSnap)], ['Payment', r.payment.number], ['Method', methodLabel], ...(r.reference ? ([['Reference', r.reference]] as [string, string][]) : [])],
      business: await pdfBusiness(tx, businessId, bSnap), billTo: customerBlock(cSnap), references: await vehicleRefs(tx, businessId, inv?.vehicleId ?? null, inv?.jobId ?? null, null),
      lines: [{ description: inv ? `Payment received for invoice ${inv.number}` : r.payment.purpose === 'DEPOSIT' ? 'Deposit received' : 'Payment received', quantityMilli: 1000, unitPriceCents: r.amountCents, discountCents: 0, vatCents: 0, totalCents: r.amountCents }],
      totals, sections: [], footer: bSnap.footer,
    },
  };
}

// ───────── Statement ─────────

export async function renderStatement(model: PdfStatementModel): Promise<Buffer> {
  return renderStatementPdf(model);
}

// ───────── Rendering and filing ─────────

export const renderInvoice = async (businessId: string, invoiceId: string) => {
  const { model, filename } = await withTenant(businessId, (tx) => invoicePdfModel(tx, businessId, invoiceId));
  return { pdf: await renderDocumentPdf(model), filename };
};
