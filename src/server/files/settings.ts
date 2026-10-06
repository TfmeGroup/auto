import { z } from 'zod';
import { env } from '@/lib/env';
import { parseOrThrow } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

export interface DocumentSettingsOut {
  trashRetentionDays: number;
  financialRetentionYears: number;
  /** Per-business cap (MB), never above the platform cap. */
  maxUploadMb: number | null;
  /** The limit actually applied to an upload. */
  effectiveMaxUploadMb: number;
  platformMaxUploadMb: number;
}

export async function loadDocumentSettings(tx: Tx, businessId: string): Promise<DocumentSettingsOut> {
  const s = await tx.documentSettings.upsert({ where: { businessId }, create: { businessId }, update: {} });
  const platform = env().MAX_UPLOAD_MB;
  return {
    trashRetentionDays: s.trashRetentionDays,
    financialRetentionYears: s.financialRetention,
    maxUploadMb: s.maxUploadMb,
    effectiveMaxUploadMb: Math.min(platform, s.maxUploadMb ?? platform),
    platformMaxUploadMb: platform,
  };
}

export async function getDocumentSettings(ctx: BusinessContext): Promise<DocumentSettingsOut> {
  requirePermission(ctx, 'document.view');
  return withTenant(ctx.business.id, (tx) => loadDocumentSettings(tx, ctx.business.id));
}

const schema = z.object({
  trashRetentionDays: z.coerce.number().int().min(1).max(3650),
  financialRetentionYears: z.coerce.number().int().min(1).max(50),
  maxUploadMb: z.coerce.number().int().min(1).max(100).nullable(),
});

export async function updateDocumentSettings(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'document.manage');
  requireFeature(ctx.subscription, 'advanced_documents');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(schema.partial(), input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await loadDocumentSettings(tx, ctx.business.id);
    await tx.documentSettings.update({
      where: { businessId: ctx.business.id },
      data: {
        ...(d.trashRetentionDays !== undefined ? { trashRetentionDays: d.trashRetentionDays } : {}),
        // Shortening financial retention would let documents be destroyed sooner than they were promised: it can only grow.
        ...(d.financialRetentionYears !== undefined ? { financialRetention: Math.max(d.financialRetentionYears, before.financialRetentionYears) } : {}),
        ...(d.maxUploadMb !== undefined ? { maxUploadMb: d.maxUploadMb } : {}),
      },
    });
    const after = await loadDocumentSettings(tx, ctx.business.id);
    await recordAudit(tx, ctx.meta, { action: AuditActions.documentSettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'document_settings', resourceId: ctx.business.id, before, after });
    return after;
  });
}
