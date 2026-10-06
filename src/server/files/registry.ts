import type { Tx } from '@/server/db/client';
import type { Permission } from '@/server/permissions/catalog';
import type { DocumentVisibility } from '@/generated/prisma/client';

/**
 * Every kind of record a file can be attached to, and the rules that follow from it. This is the single place those
 * rules live, so a module that wants documents adds one entry here and gets tenant checks, permission checks, location
 * scoping and customer-sharing rules for free.
 *
 *  - owner(): proves the record exists IN THIS BUSINESS and says which customer and location it belongs to. The type and id
 *    always come from a browser, so nothing is believed until this has looked the record up inside the tenant.
 *  - view: needed to see (list) files on that record, on top of document.view.
 *  - customerShareable: false means the file can NEVER be customer-visible, whatever anyone asks for. A supplier invoice,
 *    an employee certificate or a stock transfer note has no business in a customer's hands.
 *  - restricted: files default to RESTRICTED (needs document.view_restricted) instead of INTERNAL.
 */
export interface ResourceRule {
  label: string;
  owner: (tx: Tx, businessId: string, id: string) => Promise<{ customerId?: string | null; locationId?: string | null } | null>;
  view: Permission;
  /** Permission to attach/upload to this kind of record (besides document.upload). Omitted = document.upload is enough. */
  write?: Permission;
  customerShareable: boolean;
  defaultCategory: string;
  defaultVisibility?: DocumentVisibility;
}

export const RESOURCES: Record<string, ResourceRule> = {
  business: {
    label: 'Business', view: 'business.view', write: 'document.manage', customerShareable: false, defaultCategory: 'OTHER',
    owner: async (_tx, businessId, id) => (id === businessId ? {} : null),
  },
  // The business's own logo: the only valid target is the business itself.
  business_logo: {
    label: 'Logo', view: 'business.view', customerShareable: false, defaultCategory: 'OTHER',
    owner: async (_tx, businessId, id) => (id === businessId ? {} : null),
  },
  customer: {
    label: 'Customer', view: 'customer.view', customerShareable: true, defaultCategory: 'CUSTOMER_DOCUMENT',
    owner: async (tx, b, id) => ((await tx.customer.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? { customerId: id } : null),
  },
  vehicle: {
    label: 'Vehicle', view: 'vehicle.view', customerShareable: true, defaultCategory: 'VEHICLE_PHOTO',
    owner: async (tx, b, id) => {
      const v = await tx.vehicle.findFirst({ where: { id, businessId: b }, select: { customerId: true } });
      return v ? { customerId: v.customerId } : null;
    },
  },
  job: {
    label: 'Job', view: 'job.view', customerShareable: true, defaultCategory: 'JOB_DOCUMENT',
    owner: async (tx, b, id) => {
      const j = await tx.jobCard.findFirst({ where: { id, businessId: b }, select: { customerId: true, locationId: true } });
      return j ? { customerId: j.customerId, locationId: j.locationId } : null;
    },
  },
  inspection: {
    label: 'Inspection', view: 'job.view', customerShareable: true, defaultCategory: 'VEHICLE_INSPECTION',
    owner: async (tx, b, id) => {
      const i = await tx.inspection.findFirst({ where: { id, businessId: b }, select: { customerId: true, job: { select: { locationId: true } } } });
      return i ? { customerId: i.customerId, locationId: i.job.locationId } : null;
    },
  },
  diagnosis: {
    label: 'Diagnostic record', view: 'job.view', customerShareable: false, defaultCategory: 'DIAGNOSTIC',
    owner: async (tx, b, id) => {
      const d = await tx.diagnosis.findFirst({ where: { id, businessId: b }, select: { customerId: true, job: { select: { locationId: true } } } });
      return d ? { customerId: d.customerId, locationId: d.job.locationId } : null;
    },
  },
  booking: {
    label: 'Booking', view: 'booking.view', customerShareable: true, defaultCategory: 'OTHER',
    owner: async (tx, b, id) => {
      const x = await tx.booking.findFirst({ where: { id, businessId: b }, select: { customerId: true, locationId: true } });
      return x ? { customerId: x.customerId, locationId: x.locationId } : null;
    },
  },
  quote: {
    label: 'Quote', view: 'quote.view', customerShareable: true, defaultCategory: 'QUOTE',
    owner: async (tx, b, id) => {
      const x = await tx.quote.findFirst({ where: { id, businessId: b }, select: { customerId: true, locationId: true } });
      return x ? { customerId: x.customerId, locationId: x.locationId } : null;
    },
  },
  invoice: {
    label: 'Invoice', view: 'invoice.view', customerShareable: true, defaultCategory: 'INVOICE',
    owner: async (tx, b, id) => {
      const x = await tx.invoice.findFirst({ where: { id, businessId: b }, select: { customerId: true, locationId: true } });
      return x ? { customerId: x.customerId, locationId: x.locationId } : null;
    },
  },
  payment: {
    label: 'Payment', view: 'payment.view', customerShareable: false, defaultCategory: 'OTHER',
    owner: async (tx, b, id) => {
      const x = await tx.payment.findFirst({ where: { id, businessId: b }, select: { customerId: true } });
      return x ? { customerId: x.customerId } : null;
    },
  },
  receipt: {
    label: 'Receipt', view: 'payment.view', customerShareable: true, defaultCategory: 'RECEIPT',
    owner: async (tx, b, id) => {
      const x = await tx.receipt.findFirst({ where: { id, businessId: b }, select: { customerId: true } });
      return x ? { customerId: x.customerId } : null;
    },
  },
  credit_note: {
    label: 'Credit note', view: 'credit_note.view', customerShareable: true, defaultCategory: 'CREDIT_NOTE',
    owner: async (tx, b, id) => {
      const x = await tx.creditNote.findFirst({ where: { id, businessId: b }, select: { customerId: true } });
      return x ? { customerId: x.customerId } : null;
    },
  },
  // A customer statement, filed against the customer it is for.
  statement: {
    label: 'Statement', view: 'invoice.view', customerShareable: true, defaultCategory: 'STATEMENT',
    owner: async (tx, b, id) => (await tx.customer.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? { customerId: id } : null,
  },
  // Inventory, purchasing and team records are internal by nature.
  part: {
    label: 'Part', view: 'inventory.view', customerShareable: false, defaultCategory: 'PART_DOCUMENT',
    owner: async (tx, b, id) => (await tx.part.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? {} : null,
  },
  supplier: {
    label: 'Supplier', view: 'inventory.manage_suppliers', customerShareable: false, defaultCategory: 'SUPPLIER_DOCUMENT',
    owner: async (tx, b, id) => (await tx.supplier.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? {} : null,
  },
  purchase_order: {
    label: 'Purchase order', view: 'inventory.view', customerShareable: false, defaultCategory: 'PURCHASE_ORDER',
    owner: async (tx, b, id) => {
      const x = await tx.purchaseOrder.findFirst({ where: { id, businessId: b }, select: { locationId: true } });
      return x ? { locationId: x.locationId } : null;
    },
  },
  goods_receipt: {
    label: 'Goods receipt', view: 'inventory.view', customerShareable: false, defaultCategory: 'SUPPLIER_DOCUMENT',
    owner: async (tx, b, id) => (await tx.goodsReceipt.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? {} : null,
  },
  supplier_return: {
    label: 'Supplier return', view: 'inventory.view', customerShareable: false, defaultCategory: 'SUPPLIER_DOCUMENT',
    owner: async (tx, b, id) => (await tx.supplierReturn.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? {} : null,
  },
  stock_transfer: {
    label: 'Stock transfer', view: 'inventory.view', customerShareable: false, defaultCategory: 'SUPPLIER_DOCUMENT',
    owner: async (tx, b, id) => (await tx.stockTransfer.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? {} : null,
  },
  // Sensitive: certifications, training and other employment-related files.
  employee: {
    label: 'Employee', view: 'document.manage_employee', write: 'document.manage_employee', customerShareable: false, defaultCategory: 'EMPLOYEE_DOCUMENT', defaultVisibility: 'RESTRICTED',
    owner: async (tx, b, id) => (await tx.membership.findFirst({ where: { id, businessId: b }, select: { id: true } })) ? {} : null,
  },
};

/** Kinds that can never be attached to by an ordinary upload (they only ever exist as generated documents or the logo). */
export const NOT_UPLOADABLE = new Set(['business_logo']);

export const isResourceType = (t: string): boolean => Object.prototype.hasOwnProperty.call(RESOURCES, t);
