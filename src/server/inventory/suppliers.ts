import { z } from 'zod';
import { Prisma, withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { escapeLike, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { accessibleLocations, canSeeCosts } from './common';
import { userNames } from './stock';

const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
const email = z.union([z.literal(''), z.null(), z.email('Enter a valid email address')]).optional().transform((v) => (v === undefined ? undefined : v ? v.toLowerCase() : null));

const fields = {
  name: z.string().trim().min(1, 'Enter the supplier name').max(160),
  tradingName: text(160), contactPerson: text(120), phone: text(40), email, address: text(400),
  vatNumber: text(40), registrationNumber: text(60), accountNumber: text(60), paymentTerms: text(120), notes: text(2000),
};
export const supplierCreateSchema = z.object(fields);
export const supplierUpdateSchema = z.object(fields).partial();

export const supplierListSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED', 'all']).optional(),
});

/** Search by name, trading name, phone (digits only), email, account number or VAT number. */
export async function listSuppliers(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  const q = parseOrThrow(supplierListSchema, query);
  const bid = ctx.business.id;
  return withTenant(bid, async (tx) => {
    const conds: Prisma.Sql[] = [Prisma.sql`s.business_id = ${bid}::uuid`];
    if (q.status === 'all') { /* all */ } else if (q.status) conds.push(Prisma.sql`s.status = ${q.status}::inventory_status`);
    else conds.push(Prisma.sql`s.status <> 'ARCHIVED'`);
    for (const word of (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5)) {
      const like = `%${escapeLike(word)}%`;
      const digits = word.replace(/\D/g, '');
      conds.push(
        digits.length >= 3
          ? Prisma.sql`(s.name ILIKE ${like} OR s.trading_name ILIKE ${like} OR s.email ILIKE ${like} OR s.account_number ILIKE ${like} OR s.vat_number ILIKE ${like} OR regexp_replace(COALESCE(s.phone, ''), '\\D', '', 'g') LIKE ${`%${digits}%`})`
          : Prisma.sql`(s.name ILIKE ${like} OR s.trading_name ILIKE ${like} OR s.email ILIKE ${like} OR s.account_number ILIKE ${like} OR s.vat_number ILIKE ${like} OR s.phone ILIKE ${like})`,
      );
    }
    const rows = await tx.$queryRaw<{ id: string; total: bigint }[]>`
      SELECT s.id, count(*) OVER() AS total FROM suppliers s WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY lower(s.name), s.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const ids = rows.map((r) => r.id);
    const total = rows.length ? Number(rows[0]!.total) : 0;
    const suppliers = await tx.supplier.findMany({ where: { id: { in: ids }, businessId: bid } });
    const byId = new Map(suppliers.map((s) => [s.id, s]));
    const parts = await tx.partSupplier.groupBy({ by: ['supplierId'], where: { businessId: bid, supplierId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } });
    const open = await tx.purchaseOrder.groupBy({ by: ['supplierId'], where: { businessId: bid, supplierId: { in: ids }, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } }, _count: { _all: true } });
    const pc = new Map(parts.map((p) => [p.supplierId, p._count._all]));
    const oc = new Map(open.map((p) => [p.supplierId, p._count._all]));
    return {
      items: ids.flatMap((id) => {
        const s = byId.get(id);
        return s ? [{ id: s.id, name: s.name, tradingName: s.tradingName, contactPerson: s.contactPerson, phone: s.phone, email: s.email, accountNumber: s.accountNumber, status: s.status, partCount: pc.get(id) ?? 0, openOrders: oc.get(id) ?? 0 }] : [];
      }),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function getSupplier(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, id);
  const costs = canSeeCosts(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const s = await tx.supplier.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!s) throw Errors.notFound('Supplier');
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const orderWhere = { businessId: ctx.business.id, supplierId: id, locationId: { in: locs } };
    const [orderCount, openCount, recent, linked, returns, lastReceipt, totals] = [
      await tx.purchaseOrder.count({ where: orderWhere }),
      await tx.purchaseOrder.count({ where: { ...orderWhere, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } } }),
      await tx.purchaseOrder.findMany({ where: orderWhere, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, number: true, status: true, poDate: true, expectedDate: true, totalCents: true } }),
      await tx.partSupplier.findMany({ where: { businessId: ctx.business.id, supplierId: id, status: 'ACTIVE' }, include: { part: { select: { id: true, sku: true, name: true, status: true } } }, orderBy: { part: { name: 'asc' } }, take: 200 }),
      await tx.supplierReturn.count({ where: { businessId: ctx.business.id, supplierId: id, locationId: { in: locs } } }),
      await tx.goodsReceipt.findFirst({ where: { businessId: ctx.business.id, supplierId: id, locationId: { in: locs } }, orderBy: { receivedAt: 'desc' }, select: { number: true, receivedAt: true } }),
      costs
        ? await tx.purchaseOrder.aggregate({ where: { ...orderWhere, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'] } }, _sum: { totalCents: true } })
        : null,
    ];
    const by = await userNames(tx, [s.createdById, s.updatedById]);
    return {
      supplier: s,
      summary: { orderCount, openOrders: openCount, returns, lastDelivery: lastReceipt, orderedTotalCents: costs ? (totals?._sum.totalCents ?? 0) : null },
      recentOrders: recent.map((o) => ({ ...o, totalCents: costs ? o.totalCents : null })),
      parts: linked.map((l) => ({ id: l.part.id, sku: l.part.sku, name: l.part.name, status: l.part.status, supplierPartNumber: l.supplierPartNumber, supplierCostCents: costs ? l.supplierCostCents : null, leadTimeDays: l.leadTimeDays, preferred: l.preferred })),
      createdByName: s.createdById ? (by.get(s.createdById) ?? null) : null,
      updatedByName: s.updatedById ? (by.get(s.updatedById) ?? null) : null,
      canSeeCosts: costs,
    };
  });
}

export const supplierHistorySchema = paginationSchema.extend({
  status: z.string().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Every order placed with a supplier, filterable by status and date. Costs only for people allowed to see them. */
export async function supplierPurchaseHistory(ctx: BusinessContext, id: string, query: unknown) {
  requirePermission(ctx, 'inventory.view');
  parseOrThrow(uuidSchema, id);
  const q = parseOrThrow(supplierHistorySchema, query);
  const costs = canSeeCosts(ctx);
  const statuses = q.status ? q.status.split(',').map((s) => s.trim().toUpperCase()) : null;
  return withTenant(ctx.business.id, async (tx) => {
    if (!(await tx.supplier.findFirst({ where: { id, businessId: ctx.business.id }, select: { id: true } }))) throw Errors.notFound('Supplier');
    const locs = (await accessibleLocations(tx, ctx)).map((l) => l.id);
    const where = {
      businessId: ctx.business.id, supplierId: id, locationId: { in: locs },
      ...(statuses ? { status: { in: statuses as never[] } } : {}),
      ...(q.from || q.to ? { poDate: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}) } } : {}),
    };
    const total = await tx.purchaseOrder.count({ where });
    const rows = await tx.purchaseOrder.findMany({ where, orderBy: { poDate: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lines: { select: { quantityOrdered: true, quantityReceived: true } } } });
    return {
      items: rows.map((o) => ({ id: o.id, number: o.number, status: o.status, poDate: o.poDate, expectedDate: o.expectedDate, ordered: o.lines.reduce((s, l) => s + l.quantityOrdered, 0), received: o.lines.reduce((s, l) => s + l.quantityReceived, 0), totalCents: costs ? o.totalCents : null })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function createSupplier(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.manage_suppliers');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(supplierCreateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const s = await tx.supplier.create({
      data: { businessId: ctx.business.id, name: d.name, tradingName: d.tradingName ?? null, contactPerson: d.contactPerson ?? null, phone: d.phone ?? null, email: d.email ?? null, address: d.address ?? null, vatNumber: d.vatNumber ?? null, registrationNumber: d.registrationNumber ?? null, accountNumber: d.accountNumber ?? null, paymentTerms: d.paymentTerms ?? null, notes: d.notes ?? null, createdById: ctx.user.id, updatedById: ctx.user.id },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.supplierCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'supplier', resourceId: s.id, after: { name: s.name } });
    return s;
  });
}

export async function updateSupplier(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'inventory.manage_suppliers');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(supplierUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.supplier.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Supplier');
    const data = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
    const after = await tx.supplier.update({ where: { id }, data: { ...data, updatedById: ctx.user.id } });
    const changed = Object.keys(data).filter((k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
    if (changed.length) await recordAudit(tx, ctx.meta, { action: AuditActions.supplierUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'supplier', resourceId: id, before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])) });
    return after;
  });
}

export async function setSupplierStatus(ctx: BusinessContext, id: string, status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED') {
  requirePermission(ctx, 'inventory.manage_suppliers');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  parseOrThrow(z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']), status);
  return withTenant(ctx.business.id, async (tx) => {
    const s = await tx.supplier.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!s) throw Errors.notFound('Supplier');
    if (s.status === status) return s;
    if (status !== 'ACTIVE') {
      const open = await tx.purchaseOrder.count({ where: { businessId: ctx.business.id, supplierId: id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'] } } });
      if (open > 0) throw Errors.conflict(`This supplier still has ${open} open purchase order${open === 1 ? '' : 's'}. Finish or cancel them first.`);
    }
    const after = await tx.supplier.update({ where: { id }, data: { status, updatedById: ctx.user.id } });
    if (status === 'ARCHIVED') await tx.part.updateMany({ where: { businessId: ctx.business.id, primarySupplierId: id }, data: { primarySupplierId: null } });
    await recordAudit(tx, ctx.meta, { action: status === 'ARCHIVED' ? AuditActions.supplierArchived : AuditActions.supplierUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'supplier', resourceId: id, before: { status: s.status }, after: { status }, metadata: { name: s.name } });
    return after;
  });
}
