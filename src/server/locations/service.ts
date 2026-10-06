import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { emailSchema, optionalText, parseOrThrow, phoneSchema, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite, assertWithinLimit } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

const optionalContact = z.union([z.null(), z.literal(''), z.string().trim().max(160)]).optional().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
export const locationSchema = z.object({
  name: z.string().trim().min(2, 'Give the location a name').max(80), notes: optionalText(200).optional(),
  addressLine1: optionalContact, city: optionalContact, province: optionalContact, postalCode: optionalContact,
  phone: z.union([z.null(), z.literal(''), phoneSchema]).optional().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v)),
  email: z.union([z.null(), z.literal(''), emailSchema]).optional().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v)),
});
const CONTACT = ['addressLine1', 'city', 'province', 'postalCode', 'phone', 'email'] as const;
const mayManage = (ctx: BusinessContext) => { if (!ctx.permissions.has('location.manage') && !ctx.permissions.has('settings.edit')) requirePermission(ctx, 'location.manage'); };

export async function listLocations(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, (tx) =>
    tx.location.findMany({ where: { businessId: ctx.business.id }, orderBy: [{ status: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true, isDefault: true, status: true, createdAt: true, docCode: true, addressLine1: true, city: true, province: true, postalCode: true, phone: true, email: true } }),
  );
}

/** The first location is included in every plan; any further location needs the multi_location entitlement AND room under the plan's limit. */
export async function createLocation(ctx: BusinessContext, input: unknown) {
  mayManage(ctx);
  assertCanWrite(ctx.subscription);
  const data = parseOrThrow(locationSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const existing = await tx.location.count({ where: { businessId: ctx.business.id, status: 'ACTIVE' } });
    if (existing >= 1) requireFeature(ctx.subscription, 'multi_location');
    await assertWithinLimit(tx, ctx.business.id, ctx.subscription, 'locations');
    const loc = await tx.location.create({ data: { businessId: ctx.business.id, name: data.name, isDefault: existing === 0, ...Object.fromEntries(CONTACT.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])) } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.locationCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'location', resourceId: loc.id, after: { name: loc.name } });
    return loc;
  });
}

/** Change a location's name and contact details. A location's contact details are used on its own documents; the business's are used where it has none. */
export async function renameLocation(ctx: BusinessContext, id: string, input: unknown) {
  mayManage(ctx);
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(locationSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.location.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Location');
    const patch = { name: data.name, ...Object.fromEntries(CONTACT.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])) };
    const after = await tx.location.update({ where: { id }, data: patch });
    const view = (x: typeof before) => ({ name: x.name, addressLine1: x.addressLine1, city: x.city, province: x.province, postalCode: x.postalCode, phone: x.phone, email: x.email });
    await recordAudit(tx, ctx.meta, { action: AuditActions.locationUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'location', resourceId: id, before: view(before), after: view(after) });
    return after;
  });
}

/** Locations are archived, never deleted. The default location cannot be archived. */
export async function archiveLocation(ctx: BusinessContext, id: string) {
  mayManage(ctx);
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const loc = await tx.location.findFirst({ where: { id, businessId: ctx.business.id, status: 'ACTIVE' } });
    if (!loc) throw Errors.notFound('Location');
    if (loc.isDefault) throw Errors.conflict('The main location cannot be archived.');
    await tx.location.update({ where: { id }, data: { status: 'ARCHIVED' } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.locationArchived, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'location', resourceId: id, metadata: { name: loc.name } });
  });
}
