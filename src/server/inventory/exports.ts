import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { toCsv, toXlsx, type Cell, type Column } from '@/lib/tabular';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import type { BusinessContext } from '@/server/context';
import { canSeeCosts } from './common';
import { listParts } from './parts';
import { listPurchaseOrders } from './purchasing';
import { lowStockReport, marginReport, usageReport, valuationReport } from './reports';
import { listMovements, MOVEMENT_LABEL, type MovementType } from './stock';
import { supplierPurchaseHistory } from './suppliers';

/**
 * Inventory exports (CSV or Excel). Needs inventory.export and the plan's data-export feature; costs, valuation and margins are only included for
 * people who may see costs; location access is applied by the same readers the screens use; every export is audited with what was exported and how many
 * rows. A row limit stops an export from loading unbounded data.
 */

export const INVENTORY_EXPORT_LIMIT = 20_000;
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');

export const inventoryExportSchema = z.object({
  dataset: z.enum(['stock_list', 'movements', 'low_stock', 'purchase_orders', 'supplier_history', 'part_usage', 'valuation', 'profitability']),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  from: iso.optional(),
  to: iso.optional(),
  locationId: uuidSchema.optional(),
  supplierId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  status: z.string().max(100).optional(),
  q: z.string().trim().max(100).optional(),
  by: z.string().max(20).optional(),
});

const T: Column['kind'] = 'text';
const M: Column['kind'] = 'money';
const N: Column['kind'] = 'int';
interface Built { title: string; columns: Column[]; rows: Cell[][] }
const col = (header: string, kind: Column['kind']): Column => ({ header, kind });
const day = (d: Date | string | null | undefined) => (d ? (typeof d === 'string' ? d : d.toISOString().slice(0, 10)) : '');

async function pages<T>(read: (page: number) => Promise<{ items: T[]; meta: { totalPages: number } }>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 500; page++) {
    const r = await read(page);
    out.push(...r.items);
    if (page >= r.meta.totalPages || out.length > INVENTORY_EXPORT_LIMIT) break;
  }
  return out;
}

export async function exportInventory(ctx: BusinessContext, query: unknown): Promise<{ data: Buffer; filename: string; mime: string; rows: number }> {
  requirePermission(ctx, 'inventory.export');
  requireFeature(ctx.subscription, 'data_export');
  const q = parseOrThrow(inventoryExportSchema, query);
  await consume({ key: `inventory-export:${ctx.business.id}`, limit: 20, windowSec: 3600 });
  const costs = canSeeCosts(ctx);
  let built: Built;

  switch (q.dataset) {
    case 'stock_list': {
      const items = await pages((page) => listParts(ctx, { page, pageSize: 100, q: q.q, locationId: q.locationId, supplierId: q.supplierId, categoryId: q.categoryId, status: q.status === 'ARCHIVED' || q.status === 'INACTIVE' || q.status === 'ACTIVE' ? q.status : undefined }));
      built = {
        title: 'Stock list',
        columns: [col('SKU', T), col('Part number', T), col('Name', T), col('Category', T), col('Brand', T), col('Barcode', T), col('Unit', T), col('On hand', N), col('Reserved', N), col('Available', N), col('Stock level', T), col('Minimum stock', N), col('Reorder level', N), col('Selling price', M), ...(costs ? [col('Cost', M), col('Stock value (operational)', M)] : []), col('Primary supplier', T), col('Status', T)],
        rows: items.map((p) => [p.sku, p.partNumber, p.name, p.categoryName, p.brand, p.barcode, p.unit, p.onHand, p.reserved, p.available, p.state, p.minStock, p.reorderLevel, p.sellPriceCents, ...(costs ? [p.costCents, p.costCents !== null && p.onHand > 0 ? p.costCents * p.onHand : null] : []), p.primarySupplierName, p.status]),
      };
      break;
    }
    case 'movements': {
      const items = await pages((page) => listMovements(ctx, { page, pageSize: 100, from: q.from, to: q.to, locationId: q.locationId, q: q.q, type: q.status }));
      built = {
        title: 'Stock movements',
        columns: [col('Date', T), col('Type', T), col('SKU', T), col('Part', T), col('Location', T), col('On hand change', N), col('Reserved change', N), col('On hand before', N), col('On hand after', N), col('Job', T), col('Reason', T), col('By', T), ...(costs ? [col('Unit cost', M)] : [])],
        rows: items.map((m) => [m.createdAt.toISOString(), MOVEMENT_LABEL[m.type as MovementType], m.sku, m.partName, m.locationName, m.onHandDelta, m.reservedDelta, m.onHandBefore, m.onHandAfter, m.jobNumber, m.reason, m.by, ...(costs ? [m.unitCostCents] : [])]),
      };
      break;
    }
    case 'low_stock': {
      const items = await lowStockReport(ctx, { locationId: q.locationId, limit: 500 });
      built = { title: 'Low stock', columns: [col('SKU', T), col('Part', T), col('On hand', N), col('Reserved', N), col('Available', N), col('Minimum', N), col('Reorder level', N), col('State', T), col('Supplier', T), col('Suggested order', N), ...(costs ? [col('Estimated cost', M)] : [])], rows: items.map((i) => [i.sku, i.name, i.onHand, i.reserved, i.available, i.minStock, i.reorderLevel, i.state, i.supplier, i.suggestedOrder, ...(costs ? [i.estimatedCostCents] : [])]) };
      break;
    }
    case 'purchase_orders': {
      requirePermission(ctx, 'inventory.view');
      const items = await pages((page) => listPurchaseOrders(ctx, { page, pageSize: 100, from: q.from, to: q.to, supplierId: q.supplierId, status: q.status, locationId: q.locationId, q: q.q }));
      built = { title: 'Purchase orders', columns: [col('PO number', T), col('Supplier', T), col('Location', T), col('Status', T), col('Order date', T), col('Expected', T), col('Units ordered', N), col('Units received', N), ...(costs ? [col('Total', M)] : [])], rows: items.map((o) => [o.number, o.supplierName, o.locationName, o.status, o.poDate, o.expectedDate, o.ordered, o.received, ...(costs ? [o.totalCents] : [])]) };
      break;
    }
    case 'supplier_history': {
      if (!q.supplierId) throw Errors.validation({ supplierId: 'Choose a supplier.' });
      const items = await pages((page) => supplierPurchaseHistory(ctx, q.supplierId!, { page, pageSize: 100, from: q.from, to: q.to, status: q.status }));
      built = { title: 'Supplier purchase history', columns: [col('PO number', T), col('Status', T), col('Order date', T), col('Expected', T), col('Units ordered', N), col('Units received', N), ...(costs ? [col('Total', M)] : [])], rows: items.map((o) => [o.number, o.status, day(o.poDate), day(o.expectedDate), o.ordered, o.received, ...(costs ? [o.totalCents] : [])]) };
      break;
    }
    case 'part_usage': {
      const r = await usageReport(ctx, { from: q.from, to: q.to, locationId: q.locationId, limit: 500 });
      built = { title: 'Part usage', columns: [col('SKU', T), col('Part', T), col('Units used', N), col('Jobs', N), ...(costs ? [col('Cost of units used', M)] : [])], rows: r.items.map((i) => [i.sku, i.name, i.units, i.jobs, ...(costs ? [i.costCents] : [])]) };
      break;
    }
    case 'valuation': {
      const r = await valuationReport(ctx, { locationId: q.locationId, by: q.by === 'supplier' || q.by === 'location' ? q.by : 'category' });
      built = { title: 'Operational valuation', columns: [col('Group', T), col('Parts', N), col('Units on hand', N), col('Value at current cost (operational)', M), col('Parts without a cost', N)], rows: r.rows.map((x) => [x.label, x.parts, x.units, x.valueCents, x.partsWithoutCost]) };
      break;
    }
    case 'profitability': {
      const r = await marginReport(ctx, { from: q.from, to: q.to, by: q.by === 'job' || q.by === 'customer' || q.by === 'vehicle' || q.by === 'invoice' ? q.by : 'part', limit: 500 });
      built = { title: 'Part profitability', columns: [col('Item', T), col('Revenue (excl. VAT)', M), col('Cost', M), col('Margin', M), col('Margin %', T), col('Lines', N), col('Lines with no cost', N)], rows: r.items.map((x) => [x.label, x.revenueCents, x.costCents, x.marginCents, x.marginBps === null ? '' : (x.marginBps / 100).toFixed(1), x.lines, x.linesWithoutCost]) };
      break;
    }
  }

  if (built.rows.length > INVENTORY_EXPORT_LIMIT) throw Errors.validation({ from: `That is more than ${INVENTORY_EXPORT_LIMIT.toLocaleString('en-ZA')} rows. Narrow it down.` });
  const data = q.format === 'xlsx' ? toXlsx(built.title, built.columns, built.rows) : toCsv(built.columns, built.rows);
  const stamp = new Date().toISOString().slice(0, 10);
  await withTenant(ctx.business.id, (tx) =>
    recordAudit(tx, ctx.meta, { action: AuditActions.stockExported, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'inventory_export', resourceId: ctx.business.id, metadata: { dataset: q.dataset, format: q.format, rows: built.rows.length, withCosts: costs, from: q.from ?? null, to: q.to ?? null, locationId: q.locationId ?? null } }),
  );
  return { data, filename: `tfme-auto-${q.dataset.replace(/_/g, '-')}-${stamp}.${q.format}`, mime: q.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8', rows: built.rows.length };
}
