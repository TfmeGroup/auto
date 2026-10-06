import type { Tx } from '@/server/db/client';
import type { Permission } from '@/server/permissions/catalog';

/**
 * Exportable datasets. Each module registers one entry (Part 3+: vehicles, jobs, bookings, quotes,
 * invoices, payments, inventory, suppliers). The export service takes care of permissions, tenant
 * isolation, background generation, expiry, auditing and secure download — a dataset only says
 * what to read. A requester only ever gets datasets whose `permission` they hold.
 *
 * `fetch` runs inside withTenant(), AND every query must still filter by businessId explicitly.
 */
export interface ExportDataset {
  key: string;
  label: string;
  permission: Permission;
  fetch(tx: Tx, businessId: string): Promise<unknown[]>;
}

const PAGE = 1000;

/** Read a table in id-ordered pages so large datasets don't need one giant query. */
async function paged<T extends { id: string }>(read: (cursor: string | undefined) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await read(cursor);
    all.push(...rows);
    if (rows.length < PAGE) return all;
    cursor = rows[rows.length - 1]!.id;
  }
}

export const EXPORT_DATASETS: ExportDataset[] = [
  {
    key: 'business',
    label: 'Business profile',
    permission: 'business.view',
    async fetch(tx, businessId) {
      const b = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
      const { logoFileId: _l, closedById: _c, createdById: _x, ...rest } = b;
      void _l; void _c; void _x;
      return [rest];
    },
  },
  {
    key: 'team',
    label: 'Team members',
    permission: 'employee.view',
    async fetch(tx, businessId) {
      const rows = await tx.membership.findMany({ where: { businessId }, include: { user: { select: { name: true, email: true, mobile: true } }, role: { select: { name: true, key: true } } } });
      return rows.map((m) => ({
        id: m.id, status: m.status, name: m.user?.name ?? null, email: m.user?.email ?? m.invitedEmail, mobile: m.user?.mobile ?? null,
        role: m.role.name, joinedAt: m.joinedAt, invitedAt: m.invitedAt,
      }));
    },
  },
  {
    key: 'customers',
    label: 'Customers',
    permission: 'customer.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.customer.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'vehicles',
    label: 'Vehicles',
    permission: 'vehicle.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.vehicle.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'vehicle_mileage',
    label: 'Vehicle mileage history',
    permission: 'vehicle.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.vehicleMileage.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'bookings',
    label: 'Bookings',
    permission: 'booking.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.booking.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'jobs',
    label: 'Job cards',
    permission: 'job.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.jobCard.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'job_notes',
    label: 'Job notes (internal and customer-visible)',
    permission: 'job.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.jobNote.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'inspections',
    label: 'Inspections',
    permission: 'job.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.inspection.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'inspection_items',
    label: 'Inspection items',
    permission: 'job.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.inspectionItem.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'diagnoses',
    label: 'Diagnostic records',
    permission: 'job.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.diagnosis.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'recommended_work',
    label: 'Recommended work (without prices)',
    permission: 'job.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.recommendedWork.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, omit: { estimatedLabourCents: true, estimatedPartsCents: true }, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'job_parts_labour_pricing',
    label: 'Job parts (with costs and prices)',
    permission: 'job.view_pricing',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.jobPart.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'job_labour_pricing',
    label: 'Job labour (with rates and totals)',
    permission: 'job.view_pricing',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.jobLabour.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'documents',
    label: 'Documents and photos (details)',
    permission: 'document.export',
    fetch: (tx, businessId) =>
      paged((cursor) =>
        tx.file.findMany({
          where: { businessId },
          orderBy: { id: 'asc' },
          take: PAGE,
          select: { id: true, originalName: true, mimeType: true, sizeBytes: true, sha256: true, resourceType: true, resourceId: true, status: true, createdAt: true },
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        }),
      ),
  },
  {
    key: 'parts',
    label: 'Parts catalogue (without costs)',
    permission: 'inventory.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.part.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, omit: { costCents: true }, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'parts_costs',
    label: 'Parts catalogue (with costs) and price history',
    permission: 'inventory.view_costs',
    fetch: async (tx, businessId) => [
      ...(await paged((cursor) => tx.part.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }))),
      ...(await paged((cursor) => tx.partPriceHistory.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }))),
    ],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    permission: 'inventory.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.supplier.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'stock_levels',
    label: 'Stock levels by location',
    permission: 'inventory.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.stockLevel.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'stock_movements',
    label: 'Stock movements (without costs)',
    permission: 'inventory.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.stockMovement.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, omit: { unitCostCents: true }, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'purchase_orders',
    label: 'Purchase orders, deliveries and returns (with costs)',
    permission: 'inventory.view_costs',
    fetch: async (tx, businessId) => [
      ...(await paged((cursor) => tx.purchaseOrder.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }))),
      ...(await paged((cursor) => tx.purchaseOrderLine.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }))),
      ...(await paged((cursor) => tx.goodsReceipt.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }))),
      ...(await paged((cursor) => tx.goodsReceiptLine.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }))),
      ...(await paged((cursor) => tx.supplierReturn.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) }))),
    ],
  },
  {
    key: 'time_entries',
    label: 'Time entries',
    permission: 'time.view_all',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.timeEntry.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
  {
    key: 'audit',
    label: 'Audit log',
    permission: 'audit.view',
    fetch: (tx, businessId) =>
      paged((cursor) => tx.auditLog.findMany({ where: { businessId }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })),
  },
];

export const datasetByKey = (key: string) => EXPORT_DATASETS.find((d) => d.key === key);
