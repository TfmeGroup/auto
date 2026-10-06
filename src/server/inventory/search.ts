import { Prisma } from '@/server/db/client';
import { escapeLike } from '@/lib/validation';
import type { SearchProvider } from '@/server/search/registry';

/** Global-search providers for the catalogue, suppliers and purchase orders. Counts and costs never appear in a hit, only names and numbers. */

const words = (q: string) => q.split(/\s+/).filter(Boolean).slice(0, 4);

export const partSearchProvider: SearchProvider = {
  key: 'parts',
  label: 'Parts',
  permission: 'inventory.view',
  async search(tx, businessId, query, limit) {
    const conds: Prisma.Sql[] = [Prisma.sql`p.business_id = ${businessId}::uuid`, Prisma.sql`p.status <> 'ARCHIVED'`];
    for (const w of words(query)) {
      const like = `%${escapeLike(w)}%`;
      conds.push(Prisma.sql`(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR p.part_number ILIKE ${like} OR p.barcode ILIKE ${like} OR p.brand ILIKE ${like} OR EXISTS (SELECT 1 FROM part_suppliers ps WHERE ps.part_id = p.id AND ps.supplier_part_number ILIKE ${like}))`);
    }
    const rows = await tx.$queryRaw<{ id: string; sku: string; name: string; brand: string | null; part_number: string | null }[]>`
      SELECT p.id, p.sku, p.name, p.brand, p.part_number FROM parts p WHERE ${Prisma.join(conds, ' AND ')} ORDER BY lower(p.name) LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: `${r.sku} — ${r.name}`, subtitle: [r.brand, r.part_number].filter(Boolean).join(' · ') || undefined, href: `/inventory/parts/${r.id}` }));
  },
};

export const supplierSearchProvider: SearchProvider = {
  key: 'suppliers',
  label: 'Suppliers',
  permission: 'inventory.view',
  async search(tx, businessId, query, limit) {
    const conds: Prisma.Sql[] = [Prisma.sql`s.business_id = ${businessId}::uuid`, Prisma.sql`s.status <> 'ARCHIVED'`];
    for (const w of words(query)) {
      const like = `%${escapeLike(w)}%`;
      conds.push(Prisma.sql`(s.name ILIKE ${like} OR s.trading_name ILIKE ${like} OR s.email ILIKE ${like} OR s.phone ILIKE ${like} OR s.account_number ILIKE ${like} OR s.vat_number ILIKE ${like})`);
    }
    const rows = await tx.$queryRaw<{ id: string; name: string; contact_person: string | null; phone: string | null }[]>`
      SELECT s.id, s.name, s.contact_person, s.phone FROM suppliers s WHERE ${Prisma.join(conds, ' AND ')} ORDER BY lower(s.name) LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.name, subtitle: [r.contact_person, r.phone].filter(Boolean).join(' · ') || undefined, href: `/inventory/suppliers/${r.id}` }));
  },
};

export const purchaseOrderSearchProvider: SearchProvider = {
  key: 'purchase_orders',
  label: 'Purchase orders',
  permission: 'inventory.view',
  async search(tx, businessId, query, limit) {
    const conds: Prisma.Sql[] = [Prisma.sql`po.business_id = ${businessId}::uuid`];
    for (const w of words(query)) {
      const like = `%${escapeLike(w)}%`;
      conds.push(Prisma.sql`(po.number ILIKE ${like} OR s.name ILIKE ${like})`);
    }
    const rows = await tx.$queryRaw<{ id: string; number: string; status: string; supplier: string }[]>`
      SELECT po.id, po.number, po.status, s.name AS supplier FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE ${Prisma.join(conds, ' AND ')} ORDER BY po.created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.number, subtitle: `${r.supplier} · ${r.status.toLowerCase().replace(/_/g, ' ')}`, href: `/purchase-orders/${r.id}` }));
  },
};

export const INVENTORY_SEARCH_PROVIDERS = [partSearchProvider, supplierSearchProvider, purchaseOrderSearchProvider];
