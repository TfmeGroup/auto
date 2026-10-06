import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { requirePermission } from '@/server/permissions/authorize';
import { businessSnapshot, loadFinanceSettings } from '@/server/finance/common';
import { loadLogo } from '@/server/finance/documents';
import { renderDocumentPdf, type PdfDocumentModel } from '@/server/finance/pdf';
import type { BusinessContext } from '@/server/context';
import { accessibleLocations } from './common';
import { PO_STATUS_LABEL } from './purchasing';

/**
 * The purchase order as a PDF, drawn from the stored order (never from anything a browser sent), with the business's own name, logo and details.
 * It goes to a SUPPLIER: it carries the supplier, the delivery location, quantities, the agreed costs, VAT and terms, and nothing about customers.
 * Costs appear on it, so only people who may see costs can produce it.
 */
export async function purchaseOrderPdf(ctx: BusinessContext, id: string): Promise<{ pdf: Buffer; filename: string; number: string }> {
  requirePermission(ctx, 'inventory.view');
  requirePermission(ctx, 'inventory.view_costs');
  parseOrThrow(uuidSchema, id);
  const model = await withTenant(ctx.business.id, async (tx) => {
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    return purchaseOrderPdfModel(tx, ctx.business.id, id, locs);
  });
  return { pdf: await renderDocumentPdf(model), filename: `${model.number}.pdf`, number: model.number };
}

/** The order as a PDF model, from stored rows. `locationIds` limits it to places the caller may use (null = no limit, for the system). */
export async function purchaseOrderPdfModel(tx: Tx, businessId: string, id: string, locationIds: string[] | null): Promise<PdfDocumentModel> {
  {
    const po = await tx.purchaseOrder.findFirst({ where: { id, businessId, ...(locationIds ? { locationId: { in: locationIds } } : {}) }, include: { lines: { orderBy: { position: 'asc' } } } });
    if (!po) throw Errors.notFound('Purchase order');
    const supplier = await tx.supplier.findFirstOrThrow({ where: { id: po.supplierId, businessId } });
    const loc = await tx.location.findFirst({ where: { id: po.locationId, businessId }, select: { name: true } });
    const settings = await loadFinanceSettings(tx, businessId);
    const b = await businessSnapshot(tx, businessId, settings, po.locationId);
    const day = (d: Date | null) => (d ? formatDate(d, 'UTC', b.locale) : '-');
    const m: PdfDocumentModel = {
      title: 'PURCHASE ORDER', number: po.number, stamp: po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL' ? 'DRAFT' : po.status === 'CANCELLED' ? 'CANCELLED' : null, billToLabel: 'SUPPLIER',
      facts: [['Order date', day(po.poDate)], ['Expected delivery', day(po.expectedDate)], ['Deliver to', loc?.name ?? '-'], ['Status', PO_STATUS_LABEL[po.status] ?? po.status]],
      business: {
        name: b.name, tradingName: b.tradingName, legalName: b.legalName, registrationNumber: b.registrationNumber, vatNumber: b.vatNumber, phone: b.phone, email: b.email, website: b.website, address: b.address, currency: b.currency, locale: b.locale,
        logo: await loadLogo(tx, businessId, b.logoFileId),
      },
      billTo: { name: supplier.name, lines: [supplier.contactPerson ? `Attn: ${supplier.contactPerson}` : null, supplier.address, supplier.phone, supplier.email, supplier.accountNumber ? `Our account no: ${supplier.accountNumber}` : null, supplier.vatNumber ? `VAT: ${supplier.vatNumber}` : null].filter((v): v is string => !!v) },
      references: [],
      lines: po.lines.map((l) => ({
        description: l.supplierPartNumber ? `${l.description} (supplier no: ${l.supplierPartNumber})` : l.description, quantityMilli: l.quantityOrdered * 1000, unitPriceCents: l.unitCostCents, discountCents: 0, vatCents: l.vatCents, totalCents: l.totalCents,
      })),
      totals: [{ label: 'Subtotal', cents: po.subtotalCents }, ...(po.vatRegistered ? [{ label: `VAT (${(po.vatRateBps / 100).toFixed(0)}%)`, cents: po.vatCents }] : []), { label: 'Order total', cents: po.totalCents, bold: true, accent: true }],
      vatLabel: po.vatRegistered ? 'VAT' : undefined,
      sections: [
        ...(po.notes ? [{ heading: 'Notes', text: po.notes }] : []),
        { heading: 'Delivery', text: 'Please quote the purchase order number on your delivery note and invoice.' },
        ...(po.terms ? [{ heading: 'Terms', text: po.terms }] : []),
      ],
      footer: null,
    };
    return m;
  }
}
