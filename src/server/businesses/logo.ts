import { Errors } from '@/lib/errors';
import { prisma, withTenant } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { uploadFile } from '@/server/files/service';
import { getStorage } from '@/server/storage';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

const LOGO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The logo is a normal business file (private, tenant-isolated, quota-counted) that the business
 * record points at. Only images are accepted; it is served only to members of this business.
 */
export async function setBusinessLogo(ctx: BusinessContext, data: Buffer, filename: string) {
  requirePermission(ctx, 'business.edit');
  const file = await uploadFile(ctx, { data, filename, resourceType: 'business_logo', resourceId: ctx.business.id, authorisedBy: 'business.edit', allowedMimes: LOGO_TYPES });
  await withTenant(ctx.business.id, async (tx) => {
    await tx.business.update({ where: { id: ctx.business.id }, data: { logoFileId: file.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.businessSettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'business', resourceId: ctx.business.id, metadata: { logoChanged: true } });
  });
}

export async function openBusinessLogo(ctx: BusinessContext) {
  const b = await prisma().business.findUniqueOrThrow({ where: { id: ctx.business.id }, select: { logoFileId: true } });
  if (!b.logoFileId) throw Errors.notFound('Logo');
  const file = await withTenant(ctx.business.id, (tx) => tx.file.findFirst({ where: { id: b.logoFileId!, businessId: ctx.business.id } }));
  if (!file) throw Errors.notFound('Logo');
  const { stream, size } = await getStorage().get(file.storageKey);
  return { stream, size: size ?? file.sizeBytes, mime: file.mimeType };
}
