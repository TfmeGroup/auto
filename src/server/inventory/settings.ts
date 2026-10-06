import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { accessibleLocations, loadInventorySettings } from './common';

const prefix = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Use 1 to 8 letters or digits');

export const inventorySettingsSchema = z.object({
  uniqueSku: z.boolean(),
  uniquePartNumber: z.boolean(),
  uniqueBarcode: z.boolean(),
  allowNegativeStock: z.boolean(),
  autoReserveOnJobAdd: z.boolean(),
  costMethod: z.enum(['LAST_COST', 'AVERAGE_COST']),
  poPrefix: prefix,
  receiptPrefix: prefix,
  transferPrefix: prefix,
  supplierReturnPrefix: prefix,
  numberPadding: z.coerce.number().int().min(3).max(9),
  poApprovalRequired: z.boolean(),
  poApprovalThresholdCents: z.coerce.number().int().min(0).max(2_000_000_000),
  transferApprovalRequired: z.boolean(),
  poReminderDays: z.coerce.number().int().min(0).max(60),
}).partial();

export async function getInventorySettings(ctx: BusinessContext) {
  requirePermission(ctx, 'inventory.view');
  return withTenant(ctx.business.id, async (tx) => {
    const s = await loadInventorySettings(tx, ctx.business.id);
    const locations = await accessibleLocations(tx, ctx);
    const { updatedById: _u, ...rest } = s;
    void _u;
    return { ...rest, locations, canEdit: can(ctx, 'inventory.manage_settings'), canAllowNegative: can(ctx, 'inventory.negative_stock') };
  });
}

/** Identifiers used by more than one part, for the setting being switched on (turning uniqueness on over existing duplicates is refused). */
async function duplicateCount(tx: import('@/server/db/client').Tx, businessId: string, column: 'sku' | 'part_number' | 'barcode'): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM (SELECT lower(${column}) FROM parts WHERE business_id = $1::uuid AND ${column} IS NOT NULL AND ${column} <> '' GROUP BY 1 HAVING count(*) > 1) d`,
    businessId,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function updateInventorySettings(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.manage_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(inventorySettingsSchema, input);
  if (d.allowNegativeStock !== undefined && !can(ctx, 'inventory.negative_stock')) throw Errors.forbidden('You do not have permission to change whether stock may go below zero.');
  return withTenant(ctx.business.id, async (tx) => {
    const before = await loadInventorySettings(tx, ctx.business.id);
    if (d.uniqueSku === true && !before.uniqueSku && (await duplicateCount(tx, ctx.business.id, 'sku')) > 0) throw Errors.validation({ uniqueSku: 'Some parts already share a SKU. Fix them first.' });
    if (d.uniquePartNumber === true && !before.uniquePartNumber && (await duplicateCount(tx, ctx.business.id, 'part_number')) > 0) throw Errors.validation({ uniquePartNumber: 'Some parts already share a part number. Fix them first.' });
    if (d.uniqueBarcode === true && !before.uniqueBarcode && (await duplicateCount(tx, ctx.business.id, 'barcode')) > 0) throw Errors.validation({ uniqueBarcode: 'Some parts already share a barcode. Fix them first.' });
    const data = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
    const after = await tx.inventorySettings.update({ where: { businessId: ctx.business.id }, data: { ...data, updatedById: ctx.user.id } });
    const changed = Object.keys(data).filter((k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
    if (changed.length) {
      await recordAudit(tx, ctx.meta, {
        action: AuditActions.inventorySettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'inventory_settings', resourceId: ctx.business.id,
        before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])),
      });
    }
    return after;
  });
}

export const idSchema = uuidSchema;
