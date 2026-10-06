import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { escapeLike, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { Prisma, withTenant } from '@/server/db/client';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { setCustomerArchived } from '@/server/customers/service';
import { restoreFile } from '@/server/files/lifecycle';
import { searchDocuments } from '@/server/files/search';
import { setPartStatus } from '@/server/inventory/parts';
import { setSupplierStatus } from '@/server/inventory/suppliers';
import { setVehicleArchived } from '@/server/vehicles/service';
import type { Permission } from '@/server/permissions/catalog';
import type { BusinessContext } from '@/server/context';

/**
 * Archive management: one place to see what has been archived and bring it back. Restoring uses each module's own restore (with its own
 * rules and audit entry), inside the caller's business only; there is no cross-business path.
 */
export const ARCHIVE_KINDS = {
  customers: { label: 'Customers', permission: 'customer.archive' },
  vehicles: { label: 'Vehicles', permission: 'vehicle.archive' },
  parts: { label: 'Parts', permission: 'inventory.edit' },
  suppliers: { label: 'Suppliers', permission: 'inventory.manage_suppliers' },
  documents: { label: 'Documents', permission: 'document.delete' },
} as const satisfies Record<string, { label: string; permission: Permission }>;
export type ArchiveKind = keyof typeof ARCHIVE_KINDS;
const kindSchema = z.enum(Object.keys(ARCHIVE_KINDS) as [ArchiveKind, ...ArchiveKind[]]);

function gate(ctx: BusinessContext, kind: ArchiveKind) {
  requirePermission(ctx, 'admin.view');
  requireFeature(ctx.subscription, 'advanced_admin');
  requirePermission(ctx, ARCHIVE_KINDS[kind].permission);
}

export function archiveKinds(ctx: BusinessContext) {
  if (!can(ctx, 'admin.view') || !ctx.subscription.features.has('advanced_admin')) return [];
  return (Object.keys(ARCHIVE_KINDS) as ArchiveKind[]).filter((k) => can(ctx, ARCHIVE_KINDS[k].permission)).map((k) => ({ key: k, label: ARCHIVE_KINDS[k].label }));
}

export const archiveListSchema = paginationSchema.extend({ q: z.string().trim().max(80).optional() });

export interface ArchivedItem { id: string; title: string; subtitle: string | null; archivedAt: Date | null; href: string | null }

export async function listArchived(ctx: BusinessContext, kindRaw: string, query: unknown): Promise<{ items: ArchivedItem[]; meta: ReturnType<typeof pageMeta> }> {
  const kind = parseOrThrow(kindSchema, kindRaw);
  gate(ctx, kind);
  const q = parseOrThrow(archiveListSchema, query);
  const bid = ctx.business.id;
  const esc = q.q ? escapeLike(q.q) : '';
  const like = q.q ? esc : null;
  if (kind === 'documents') {
    const r = await searchDocuments(ctx, { state: 'archived', q: q.q, page: q.page, pageSize: q.pageSize });
    return { items: (r.items as { id: string; name?: string; displayName?: string | null; originalName?: string; category?: string; archivedAt?: Date | null }[]).map((f) => ({ id: f.id, title: f.displayName || f.name || f.originalName || 'Document', subtitle: f.category ?? null, archivedAt: f.archivedAt ?? null, href: '/documents/' + f.id })), meta: r.meta };
  }
  return withTenant(bid, async (tx) => {
    const page = (n: number) => pageMeta(q.page, q.pageSize, n);
    const skip = (q.page - 1) * q.pageSize;
    if (kind === 'customers') {
      const where: Prisma.CustomerWhereInput = { businessId: bid, status: 'ARCHIVED', ...(like ? { OR: [{ name: { contains: esc, mode: 'insensitive' } }, { customerNumber: { contains: esc, mode: 'insensitive' } }, { email: { contains: esc, mode: 'insensitive' } }] } : {}) };
      const [n, rows] = [await tx.customer.count({ where }), await tx.customer.findMany({ where, orderBy: { archivedAt: 'desc' }, skip, take: q.pageSize })];
      return { items: rows.map((c) => ({ id: c.id, title: c.name, subtitle: c.customerNumber, archivedAt: c.archivedAt, href: `/customers/${c.id}` })), meta: page(n) };
    }
    if (kind === 'vehicles') {
      const where: Prisma.VehicleWhereInput = { businessId: bid, archivedAt: { not: null }, ...(like ? { OR: [{ registration: { contains: esc, mode: 'insensitive' } }, { vin: { contains: esc, mode: 'insensitive' } }, { make: { contains: esc, mode: 'insensitive' } }, { model: { contains: esc, mode: 'insensitive' } }] } : {}) };
      const [n, rows] = [await tx.vehicle.count({ where }), await tx.vehicle.findMany({ where, orderBy: { archivedAt: 'desc' }, skip, take: q.pageSize })];
      return { items: rows.map((v) => ({ id: v.id, title: v.registration ?? v.vin ?? 'Vehicle', subtitle: [v.year, v.make, v.model].filter(Boolean).join(' ') || null, archivedAt: v.archivedAt, href: `/vehicles/${v.id}` })), meta: page(n) };
    }
    if (kind === 'parts') {
      const where: Prisma.PartWhereInput = { businessId: bid, status: 'ARCHIVED', ...(like ? { OR: [{ name: { contains: esc, mode: 'insensitive' } }, { sku: { contains: esc, mode: 'insensitive' } }] } : {}) };
      const [n, rows] = [await tx.part.count({ where }), await tx.part.findMany({ where, orderBy: { archivedAt: 'desc' }, skip, take: q.pageSize })];
      return { items: rows.map((p) => ({ id: p.id, title: p.name, subtitle: p.sku, archivedAt: p.archivedAt, href: `/inventory/parts/${p.id}` })), meta: page(n) };
    }
    const where: Prisma.SupplierWhereInput = { businessId: bid, status: 'ARCHIVED', ...(like ? { name: { contains: esc, mode: 'insensitive' } } : {}) };
    const [n, rows] = [await tx.supplier.count({ where }), await tx.supplier.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take: q.pageSize })];
    return { items: rows.map((s) => ({ id: s.id, title: s.name, subtitle: s.accountNumber, archivedAt: null, href: `/inventory/suppliers/${s.id}` })), meta: page(n) };
  });
}

export async function restoreArchived(ctx: BusinessContext, kindRaw: string, id: string) {
  const kind = parseOrThrow(kindSchema, kindRaw);
  gate(ctx, kind);
  const rid = parseOrThrow(uuidSchema, id);
  switch (kind) {
    case 'customers': await setCustomerArchived(ctx, rid, false); break;
    case 'vehicles': await setVehicleArchived(ctx, rid, false); break;
    case 'parts': await setPartStatus(ctx, rid, 'ACTIVE'); break;
    case 'suppliers': await setSupplierStatus(ctx, rid, 'ACTIVE'); break;
    case 'documents': await restoreFile(ctx, rid); break;
    default: throw Errors.validation({ kind: 'Unknown kind.' });
  }
  return { id: rid };
}
