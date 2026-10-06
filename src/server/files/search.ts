import { z } from 'zod';
import { escapeLike, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { Prisma, withTenant } from '@/server/db/client';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { accessFilter } from './access';
import { presentFiles } from './service';

/**
 * The document library search: ordinary database queries (no semantic or fuzzy "AI" matching). It finds a document by its own
 * name or description, by the customer it belongs to (name, phone, email, customer number), by a vehicle (registration, VIN), or
 * by the number of the record it hangs off (job, quote, invoice, receipt, payment, credit note, purchase order), or by the
 * supplier, employee or uploader. It applies exactly the same visibility rules as everything else in files/access.ts.
 */
export const TYPE_GROUPS = {
  pdf: ['application/pdf'],
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'],
  spreadsheet: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  document: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
} as const;

const date = z.iso.date().optional();

export const documentSearchSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  customerId: uuidSchema.optional(),
  resourceType: z.string().max(40).optional(),
  resourceId: uuidSchema.optional(),
  category: z.string().max(60).optional(),
  visibility: z.enum(['INTERNAL', 'CUSTOMER', 'RESTRICTED']).optional(),
  fileType: z.enum(['pdf', 'image', 'spreadsheet', 'document']).optional(),
  uploadedById: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  from: date,
  to: date,
  minSizeKb: z.coerce.number().int().min(0).optional(),
  maxSizeKb: z.coerce.number().int().min(0).optional(),
  source: z.enum(['UPLOAD', 'GENERATED']).optional(),
  state: z.enum(['active', 'archived', 'trash', 'all']).default('active'),
  allVersions: z.coerce.boolean().default(false),
  sort: z.enum(['newest', 'oldest', 'name', 'size']).default('newest'),
});
export type DocumentSearch = z.infer<typeof documentSearchSchema>;

const NUMBERED: [string, string, string][] = [
  ['job', 'job_cards', 'job_number'], ['quote', 'quotes', 'number'], ['invoice', 'invoices', 'number'], ['payment', 'payments', 'number'],
  ['receipt', 'receipts', 'number'], ['credit_note', 'credit_notes', 'number'], ['purchase_order', 'purchase_orders', 'number'],
];

export async function searchDocuments(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'document.view');
  const q = parseOrThrow(documentSearchSchema, query);
  const biz = ctx.business.id;

  return withTenant(biz, async (tx) => {
    const access = await accessFilter(tx, ctx);
    const conds: Prisma.Sql[] = [Prisma.sql`f.business_id = ${biz}::uuid`];
    conds.push(access.hiddenTypes.length ? Prisma.sql`(f.resource_type IS NULL OR f.resource_type <> ALL(${access.hiddenTypes}::text[]))` : Prisma.sql`TRUE`);
    if (!access.restrictedOk) conds.push(Prisma.sql`f.visibility <> 'RESTRICTED'`);
    if (access.scope) conds.push(Prisma.sql`(f.location_id IS NULL OR f.location_id = ANY(${access.scope}::uuid[]))`);

    conds.push(q.state === 'active' ? Prisma.sql`f.status = 'ACTIVE'` : q.state === 'archived' ? Prisma.sql`f.status = 'ARCHIVED'`
      : q.state === 'trash' ? Prisma.sql`f.status = 'TRASHED'` : Prisma.sql`f.status IN ('ACTIVE', 'ARCHIVED', 'TRASHED')`);
    // Trashed files are only for the people who can restore them.
    if (q.state !== 'active' && q.state !== 'archived') requirePermission(ctx, 'document.delete');
    if (!q.allVersions) conds.push(Prisma.sql`f.is_current`);

    if (q.customerId) conds.push(Prisma.sql`f.customer_id = ${q.customerId}::uuid`);
    if (q.resourceType) conds.push(Prisma.sql`f.resource_type = ${q.resourceType}`);
    if (q.resourceId) conds.push(Prisma.sql`f.resource_id = ${q.resourceId}`);
    if (q.category) conds.push(Prisma.sql`f.category = ${q.category}`);
    if (q.visibility) conds.push(Prisma.sql`f.visibility = ${q.visibility}::document_visibility`);
    if (q.fileType) conds.push(Prisma.sql`f.mime_type = ANY(${[...TYPE_GROUPS[q.fileType]]}::text[])`);
    if (q.uploadedById) conds.push(Prisma.sql`f.uploaded_by_id = ${q.uploadedById}::uuid`);
    if (q.locationId) conds.push(Prisma.sql`f.location_id = ${q.locationId}::uuid`);
    if (q.from) conds.push(Prisma.sql`f.created_at >= ${q.from}::date`);
    if (q.to) conds.push(Prisma.sql`f.created_at < (${q.to}::date + 1)`);
    if (q.minSizeKb !== undefined) conds.push(Prisma.sql`f.size_bytes >= ${q.minSizeKb * 1024}`);
    if (q.maxSizeKb !== undefined) conds.push(Prisma.sql`f.size_bytes <= ${q.maxSizeKb * 1024}`);
    if (q.source) conds.push(Prisma.sql`f.source = ${q.source}::file_source`);

    if (q.q) {
      const like = `%${escapeLike(q.q.toLowerCase())}%`;
      const digits = q.q.replace(/\D/g, '');
      const phone = digits.length >= 3 ? Prisma.sql`OR regexp_replace(coalesce(c.mobile, ''), '\\D', '', 'g') LIKE ${`%${digits}%`}` : Prisma.empty;
      const numbered = NUMBERED.map(([type, table, col]) =>
        Prisma.sql`OR (f.resource_type = ${type} AND f.resource_id IN (SELECT t.id::text FROM ${Prisma.raw(table)} t WHERE t.business_id = ${biz}::uuid AND lower(t.${Prisma.raw(col)}) LIKE ${like} ESCAPE '\\'))`,
      );
      conds.push(Prisma.sql`(
        lower(coalesce(f.display_name, '')) LIKE ${like} ESCAPE '\\' OR lower(f.original_name) LIKE ${like} ESCAPE '\\' OR lower(coalesce(f.description, '')) LIKE ${like} ESCAPE '\\'
        OR f.category = ${q.q.toUpperCase().replace(/\s+/g, '_')}
        OR f.customer_id IN (SELECT c.id FROM customers c WHERE c.business_id = ${biz}::uuid AND (lower(c.name) LIKE ${like} ESCAPE '\\' OR lower(coalesce(c.email, '')) LIKE ${like} ESCAPE '\\' OR lower(c.customer_number) LIKE ${like} ESCAPE '\\' ${phone}))
        OR (f.resource_type = 'vehicle' AND f.resource_id IN (SELECT v.id::text FROM vehicles v WHERE v.business_id = ${biz}::uuid AND (lower(coalesce(v.registration, '')) LIKE ${like} ESCAPE '\\' OR lower(coalesce(v.vin, '')) LIKE ${like} ESCAPE '\\')))
        OR (f.resource_type = 'job' AND f.resource_id IN (SELECT j.id::text FROM job_cards j WHERE j.business_id = ${biz}::uuid AND j.vehicle_id IN (SELECT v.id FROM vehicles v WHERE v.business_id = ${biz}::uuid AND (lower(coalesce(v.registration, '')) LIKE ${like} ESCAPE '\\' OR lower(coalesce(v.vin, '')) LIKE ${like} ESCAPE '\\'))))
        OR (f.resource_type = 'supplier' AND f.resource_id IN (SELECT s.id::text FROM suppliers s WHERE s.business_id = ${biz}::uuid AND lower(s.name) LIKE ${like} ESCAPE '\\'))
        OR (f.resource_type = 'part' AND f.resource_id IN (SELECT p.id::text FROM parts p WHERE p.business_id = ${biz}::uuid AND (lower(p.name) LIKE ${like} ESCAPE '\\' OR lower(p.sku) LIKE ${like} ESCAPE '\\')))
        OR (f.resource_type = 'employee' AND f.resource_id IN (SELECT m.id::text FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = ${biz}::uuid AND (lower(u.name) LIKE ${like} ESCAPE '\\' OR lower(u.email) LIKE ${like} ESCAPE '\\')))
        OR f.uploaded_by_id IN (SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = ${biz}::uuid AND lower(u.name) LIKE ${like} ESCAPE '\\')
        ${Prisma.join(numbered, ' ')}
      )`);
    }

    const where = Prisma.join(conds, ' AND ');
    const order = q.sort === 'oldest' ? Prisma.sql`f.created_at ASC` : q.sort === 'name' ? Prisma.sql`lower(coalesce(f.display_name, f.original_name)) ASC` : q.sort === 'size' ? Prisma.sql`f.size_bytes DESC` : Prisma.sql`f.created_at DESC`;
    const totalRows = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM files f WHERE ${where}`;
    const total = totalRows[0]?.n ?? 0;
    const ids = await tx.$queryRaw<{ id: string }[]>`SELECT f.id FROM files f WHERE ${where} ORDER BY ${order}, f.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const rows = await tx.file.findMany({ where: { businessId: biz, id: { in: ids.map((r) => r.id) } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.flatMap((r) => (byId.has(r.id) ? [byId.get(r.id)!] : []));
    return { items: await presentFiles(tx, biz, ordered), meta: pageMeta(q.page, q.pageSize, total) };
  });
}
