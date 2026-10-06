import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

/** The categories every business has. They are fixed in code (a file's category is a stable key, not free text). */
export const BUILTIN_CATEGORIES = {
  CUSTOMER_DOCUMENT: 'Customer document',
  VEHICLE_REGISTRATION: 'Vehicle registration',
  VEHICLE_INSPECTION: 'Vehicle inspection',
  VEHICLE_PHOTO: 'Vehicle photo',
  DIAGNOSTIC: 'Diagnostic',
  WARRANTY: 'Warranty',
  PART_DOCUMENT: 'Part document',
  QUOTE: 'Quote',
  INVOICE: 'Invoice',
  RECEIPT: 'Receipt',
  CREDIT_NOTE: 'Credit note',
  STATEMENT: 'Statement',
  SUPPLIER_DOCUMENT: 'Supplier document',
  PURCHASE_ORDER: 'Purchase order',
  EMPLOYEE_DOCUMENT: 'Employee document',
  REPORT: 'Report',
  JOB_DOCUMENT: 'Job document',
  OTHER: 'Other',
} as const;
export type BuiltinCategory = keyof typeof BUILTIN_CATEGORIES;
export const isBuiltinCategory = (k: string): k is BuiltinCategory => Object.prototype.hasOwnProperty.call(BUILTIN_CATEGORIES, k);

/** Financial categories: their generated documents are kept for the retention period and cannot be trashed. */
export const FINANCIAL_CATEGORIES: ReadonlySet<string> = new Set(['QUOTE', 'INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'STATEMENT']);

export interface CategoryOption {
  id?: string;
  key: string;
  label: string;
  builtin: boolean;
  active: boolean;
}

export async function categoryOptions(tx: Tx, businessId: string): Promise<CategoryOption[]> {
  const custom = await tx.documentCategory.findMany({ where: { businessId }, orderBy: { label: 'asc' } });
  return [
    ...Object.entries(BUILTIN_CATEGORIES).map(([key, label]) => ({ key, label, builtin: true, active: true })),
    ...custom.map((c) => ({ id: c.id, key: c.key, label: c.label, builtin: false, active: c.active })),
  ];
}

export async function listCategories(ctx: BusinessContext): Promise<CategoryOption[]> {
  requirePermission(ctx, 'document.view');
  return withTenant(ctx.business.id, (tx) => categoryOptions(tx, ctx.business.id));
}

/** A category a file may be given: a built-in, or one of this business's own active categories. */
export async function assertCategory(tx: Tx, businessId: string, key: string): Promise<void> {
  if (isBuiltinCategory(key)) return;
  const c = await tx.documentCategory.findFirst({ where: { businessId, key, active: true } });
  if (!c) throw Errors.validation({ category: 'Choose one of the available categories.' });
}

const labelSchema = z.object({ label: z.string().trim().min(2, 'Give the category a name').max(40) });

export async function createCategory(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'document.manage');
  requireFeature(ctx.subscription, 'advanced_documents');
  assertCanWrite(ctx.subscription);
  const { label } = parseOrThrow(labelSchema, input);
  const key = `C_${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)}`;
  if (key === 'C_') throw Errors.validation({ label: 'Use letters or numbers in the name.' });
  return withTenant(ctx.business.id, async (tx) => {
    const clash = await tx.documentCategory.findFirst({ where: { businessId: ctx.business.id, OR: [{ key }, { label: { equals: label, mode: 'insensitive' } }] } });
    if (clash) throw Errors.conflict('A category with that name already exists.');
    if (Object.values(BUILTIN_CATEGORIES).some((l) => l.toLowerCase() === label.toLowerCase())) throw Errors.conflict('That is already one of the standard categories.');
    const row = await tx.documentCategory.create({ data: { businessId: ctx.business.id, key, label } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.documentCategoryChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'document_category', resourceId: row.id, after: { label, active: true } });
    return row;
  });
}

export async function setCategoryActive(ctx: BusinessContext, id: string, active: boolean) {
  requirePermission(ctx, 'document.manage');
  requireFeature(ctx.subscription, 'advanced_documents');
  assertCanWrite(ctx.subscription);
  const catId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const row = await tx.documentCategory.findFirst({ where: { id: catId, businessId: ctx.business.id } });
    if (!row) throw Errors.notFound('Category');
    if (row.active === active) return row;
    const after = await tx.documentCategory.update({ where: { id: catId }, data: { active } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.documentCategoryChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'document_category', resourceId: catId, before: { active: row.active }, after: { active } });
    return after;
  });
}
