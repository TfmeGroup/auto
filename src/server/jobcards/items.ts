import { z } from 'zod';
import { withTenant, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { minutesAmount } from '@/lib/money';
import { optionalText, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { uploadFile } from '@/server/files/service';
import { can, requirePermission } from '@/server/permissions/authorize';
import { assertActiveMember, memberNames } from '@/server/workshop/people';
import { accessibleLocations } from '@/server/inventory/common';
import { resolveBillableRate } from '@/server/team/labour';
import { stockForParts, totalsFor } from '@/server/inventory/stock';
import { availableOf } from '@/server/inventory/calc';
import { addCatalogueJobPart, removeCatalogueJobPart, setJobPartState } from '@/server/inventory/jobparts';
import type { Tx } from '@/server/db/client';
import { loadJob, loadJobForWrite } from './common';
import type { BusinessContext } from '@/server/context';

/** Photos, parts and labour recorded against a job. Parts and labour are the foundation Part 5 builds on (inventory, time tracking). */

// ───────────────────────── photos ─────────────────────────

export const PHOTO_CATEGORIES = [
  'CHECK_IN_FRONT', 'CHECK_IN_REAR', 'CHECK_IN_LEFT', 'CHECK_IN_RIGHT', 'PARTS',
  'CHECK_IN_EXTERIOR', 'CHECK_IN_DAMAGE', 'CHECK_IN_WHEELS', 'CHECK_IN_INTERIOR', 'CHECK_IN_DASHBOARD', 'CHECK_IN_MILEAGE', 'CHECK_IN_ENGINE_BAY',
  'BEFORE_REPAIR', 'DURING_REPAIR', 'DAMAGED_COMPONENT', 'DIAGNOSTIC_EVIDENCE', 'COMPLETED_REPAIR', 'SIGNATURE', 'OTHER',
] as const;

/** The document-library category for a job photo. Check-in views and repair stages are all vehicle photos; evidence is diagnostic. */
export function photoFileCategory(c: (typeof PHOTO_CATEGORIES)[number]): string {
  if (c === 'DIAGNOSTIC_EVIDENCE') return 'DIAGNOSTIC';
  if (c === 'SIGNATURE') return 'JOB_DOCUMENT';
  if (c === 'PARTS') return 'PART_DOCUMENT';
  return 'VEHICLE_PHOTO';
}

export const photoMetaSchema = z.object({
  category: z.enum(PHOTO_CATEGORIES).default('OTHER'),
  visibility: z.enum(['INTERNAL', 'CUSTOMER']).default('INTERNAL'),
  description: optionalText(300),
  inspectionItemId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  diagnosisId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
});

const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']);

/**
 * Attach a photo to a job. The file goes through the same secure upload pipeline as every file (type sniffing, size
 * and storage limits, private storage, audit); this adds the job, vehicle, uploader, time, category and whether the
 * customer may see it. New photos are INTERNAL unless the uploader says otherwise.
 */
export async function addJobPhoto(ctx: BusinessContext, id: string, upload: { data: Buffer; filename: string }, meta: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(photoMetaSchema, meta);
  const job = await withTenant(ctx.business.id, (tx) => loadJobForWrite(tx, ctx, jobId, { allowClosed: true }));

  // The file carries the same category and visibility as the photo row, so the document library and the customer page always agree with the job card.
  const file = await uploadFile(ctx, {
    data: upload.data, filename: upload.filename, resourceType: 'job', resourceId: jobId, authorisedBy: 'job.edit', allowedMimes: IMAGE_MIMES,
    category: photoFileCategory(d.category), visibility: d.visibility, description: d.description,
  });
  try {
    return await withTenant(ctx.business.id, async (tx) => {
      if (d.inspectionItemId) {
        const item = await tx.inspectionItem.findFirst({ where: { id: d.inspectionItemId, businessId: ctx.business.id, inspection: { jobId } } });
        if (!item) throw Errors.validation({ inspectionItemId: 'That inspection item is not part of this job.' });
      }
      if (d.diagnosisId && !(await tx.diagnosis.findFirst({ where: { id: d.diagnosisId, businessId: ctx.business.id, jobId } }))) {
        throw Errors.validation({ diagnosisId: 'That diagnosis is not part of this job.' });
      }
      const photo = await tx.jobPhoto.create({
        data: {
          businessId: ctx.business.id, jobId, vehicleId: job.vehicleId, fileId: file.id, category: d.category, visibility: d.visibility,
          description: d.description ?? null, inspectionItemId: d.inspectionItemId ?? null, diagnosisId: d.diagnosisId ?? null, uploadedById: ctx.user.id,
        },
      });
      await recordAudit(tx, ctx.meta, {
        action: AuditActions.jobPhotoAdded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId,
        metadata: { photoId: photo.id, fileId: file.id, category: d.category, visibility: d.visibility },
      });
      await recordActivity(tx, ctx.business.id, ctx.user.id, {
        type: 'job.photo_added', summary: `Photo added (${d.category.toLowerCase().replace(/_/g, ' ')})`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
        visibility: d.visibility, data: { photoId: photo.id },
      });
      return { ...photo, file };
    });
  } catch (err) {
    // The photo row could not be saved: do not leave an orphaned, unattached file behind.
    await withTenant(ctx.business.id, (tx) => tx.file.updateMany({ where: { id: file.id, businessId: ctx.business.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } })).catch(() => {});
    throw err;
  }
}

export async function listJobPhotos(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.view');
  const jobId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    await loadJob(tx, ctx, jobId);
    return tx.jobPhoto.findMany({ where: { businessId: ctx.business.id, jobId, archivedAt: null }, orderBy: { createdAt: 'desc' } });
  });
}

export async function setJobPhotoVisibility(ctx: BusinessContext, id: string, photoId: string, visibility: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const pId = parseOrThrow(uuidSchema, photoId);
  const v = parseOrThrow(z.enum(['INTERNAL', 'CUSTOMER']), visibility);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId, { allowClosed: true });
    const photo = await tx.jobPhoto.findFirst({ where: { id: pId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!photo) throw Errors.notFound('Photo');
    if (photo.visibility === v) return photo;
    const after = await tx.jobPhoto.update({ where: { id: pId }, data: { visibility: v } });
    await tx.file.updateMany({ where: { id: photo.fileId, businessId: ctx.business.id }, data: { visibility: v } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.jobPhotoVisibilityChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId,
      before: { visibility: photo.visibility }, after: { visibility: v }, metadata: { photoId: pId },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'job.photo_visibility_changed', summary: `A photo was made ${v === 'CUSTOMER' ? 'visible to the customer' : 'internal'}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
    });
    return after;
  });
}

/** Photos are archived, never erased: the stored file and its record stay for audit and recovery. */
export async function removeJobPhoto(ctx: BusinessContext, id: string, photoId: string) {
  requirePermission(ctx, 'document.delete');
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const pId = parseOrThrow(uuidSchema, photoId);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId, { allowClosed: true });
    const photo = await tx.jobPhoto.findFirst({ where: { id: pId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!photo) throw Errors.notFound('Photo');
    const now = new Date();
    await tx.jobPhoto.update({ where: { id: pId }, data: { archivedAt: now } });
    await tx.file.updateMany({ where: { id: photo.fileId, businessId: ctx.business.id }, data: { status: 'ARCHIVED', archivedAt: now } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobPhotoRemoved, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, metadata: { photoId: pId, fileId: photo.fileId } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.photo_removed', summary: 'A photo was removed', customerId: job.customerId, vehicleId: job.vehicleId, jobId });
  });
}

// ───────────────────────── parts ─────────────────────────

const money = z.union([z.literal(''), z.null(), z.coerce.number().int('Enter whole cents').min(0).max(1_000_000_000)]).optional().transform((v) => (v === '' ? null : v));

const partShape = {
  description: z.string().trim().min(1, 'Enter the part').max(200),
  partNumber: optionalText(60),
  quantity: z.coerce.number().int().min(1).max(9999),
  status: z.enum(['REQUESTED', 'RESERVED', 'ORDERED', 'FITTED', 'RETURNED']),
  costCents: money,
  sellPriceCents: money,
  recommendedWorkId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  /** A part from the stock catalogue. Its name, number, price and cost come from the catalogue, never from the browser. */
  inventoryItemId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  stockLocationId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  /** Set when returning a part that is already on an invoice that has a credit note. */
  acknowledgeCreditNote: z.boolean().optional(),
};
export const partSchema = z.object({
  ...partShape,
  description: partShape.description.optional(),
  quantity: partShape.quantity.default(1),
  // Left out for a catalogue part: it is reserved straight away when the business works that way, otherwise requested.
  status: partShape.status.optional(),
}).refine((d) => d.inventoryItemId || d.description, { message: 'Enter the part', path: ['description'] });
// Updates must not inherit the create defaults (a status change must not reset the quantity).
export const partUpdateSchema = z.object(partShape).partial();

function pricingGuard(ctx: BusinessContext, d: { costCents?: number | null; sellPriceCents?: number | null }) {
  if ((d.costCents != null || d.sellPriceCents != null) && !can(ctx, 'job.view_pricing')) throw Errors.forbidden('You do not have permission to enter part costs or prices.');
}

export async function addJobPart(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(partSchema, input);
  // A catalogue part takes its price and cost from the catalogue; only someone who may see pricing can override the selling price.
  if (d.inventoryItemId) {
    requirePermission(ctx, 'inventory.view');
    if (d.costCents != null) throw Errors.forbidden('The cost of a catalogue part comes from the catalogue.');
    if (d.sellPriceCents != null) pricingGuard(ctx, { sellPriceCents: d.sellPriceCents });
  } else pricingGuard(ctx, d);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    if (d.recommendedWorkId && !(await tx.recommendedWork.findFirst({ where: { id: d.recommendedWorkId, jobId, businessId: ctx.business.id } }))) {
      throw Errors.validation({ recommendedWorkId: 'That recommended work is not part of this job.' });
    }
    if (d.inventoryItemId) {
      const r = await addCatalogueJobPart(tx, ctx, job, {
        inventoryItemId: d.inventoryItemId, quantity: d.quantity, stockLocationId: d.stockLocationId, status: d.status, sellPriceCents: d.sellPriceCents, recommendedWorkId: d.recommendedWorkId,
      });
      return { ...r.part, unavailable: r.unavailable };
    }
    const part = await tx.jobPart.create({
      data: {
        businessId: ctx.business.id, jobId, description: d.description!, partNumber: d.partNumber ?? null, quantity: d.quantity, status: d.status ?? 'REQUESTED',
        costCents: d.costCents ?? null, sellPriceCents: d.sellPriceCents ?? null, recommendedWorkId: d.recommendedWorkId ?? null, addedById: ctx.user.id,
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobPartChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, metadata: { partId: part.id, change: 'added', description: d.description, quantity: d.quantity } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.part_added', summary: `Part added: ${d.quantity} × ${d.description}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId });
    return part;
  });
}

export async function updateJobPart(ctx: BusinessContext, id: string, partId: string, input: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const pId = parseOrThrow(uuidSchema, partId);
  const d = parseOrThrow(partUpdateSchema, input);
  pricingGuard(ctx, d);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const before = await tx.jobPart.findFirst({ where: { id: pId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!before) throw Errors.notFound('Part');
    if (before.inventoryItemId) {
      // Stock-backed line: name, number and cost are the catalogue's; status and quantity move the stock; the selling price may be adjusted.
      requirePermission(ctx, 'inventory.view');
      if (d.costCents != null) throw Errors.forbidden('The cost of a catalogue part comes from the catalogue.');
      let line = before;
      if (d.status !== undefined || d.quantity !== undefined) {
        line = await setJobPartState(tx, ctx, job, before, d.status ?? (before.status as 'REQUESTED' | 'ORDERED' | 'RESERVED' | 'FITTED' | 'RETURNED'), { quantity: d.quantity, acknowledgeCreditNote: d.acknowledgeCreditNote });
      }
      if (d.sellPriceCents !== undefined && d.sellPriceCents !== line.sellPriceCents) {
        line = await tx.jobPart.update({ where: { id: pId }, data: { sellPriceCents: d.sellPriceCents } });
        await recordAudit(tx, ctx.meta, { action: AuditActions.jobPartChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, before: { sellPriceCents: before.sellPriceCents }, after: { sellPriceCents: d.sellPriceCents }, metadata: { partId: pId, change: 'price' } });
      }
      return line;
    }
    const { recommendedWorkId: _r, inventoryItemId: _i, stockLocationId: _s, acknowledgeCreditNote: _a, ...fields } = d;
    void _r; void _i; void _s; void _a;
    const after = await tx.jobPart.update({ where: { id: pId }, data: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobPartChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, metadata: { partId: pId, change: 'updated', status: after.status } });
    if (d.status && d.status !== before.status) {
      await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.part_status', summary: `${before.description}: ${d.status.toLowerCase()}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId });
    }
    return after;
  });
}

export async function removeJobPart(ctx: BusinessContext, id: string, partId: string) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const pId = parseOrThrow(uuidSchema, partId);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const p = await tx.jobPart.findFirst({ where: { id: pId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!p) throw Errors.notFound('Part');
    if (p.inventoryItemId) await removeCatalogueJobPart(tx, ctx, job, p);
    await tx.jobPart.update({ where: { id: pId }, data: { archivedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobPartChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, metadata: { partId: pId, change: 'removed' } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.part_removed', summary: `Part removed: ${p.description}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId });
  });
}

// ───────────────────────── labour ─────────────────────────

export const labourSchema = z.object({
  description: z.string().trim().min(1, 'Describe the work performed').max(300),
  minutes: z.coerce.number().int('Enter whole minutes').min(1, 'At least 1 minute').max(10_080, 'At most one week'),
  technicianMembershipId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  rateCentsPerHour: money,
});

export async function addJobLabour(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(labourSchema, input);
  if (d.rateCentsPerHour != null && !can(ctx, 'job.view_pricing')) throw Errors.forbidden('You do not have permission to enter labour rates.');
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const tech = d.technicianMembershipId ?? ctx.membership.id;
    await assertActiveMember(tx, ctx.business.id, tech, 'technicianMembershipId');
    // No rate typed: the rate in force (the technician's, else the service's, else the business default) is applied and COPIED onto this line.
    const rate = d.rateCentsPerHour ?? (await resolveBillableRate(tx, ctx.business.id, { membershipId: tech, serviceTypeId: job.serviceTypeId })).rateCentsPerHour;
    const total = rate != null ? minutesAmount(d.minutes, rate) : null;
    const row = await tx.jobLabour.create({
      data: { businessId: ctx.business.id, jobId, technicianMembershipId: tech, description: d.description, minutes: d.minutes, rateCentsPerHour: rate, totalCents: total, recordedById: ctx.user.id },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobLabourChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, metadata: { labourId: row.id, change: 'added', minutes: d.minutes } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.labour_added', summary: `Labour recorded: ${d.minutes} min — ${d.description}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId });
    return row;
  });
}

export async function removeJobLabour(ctx: BusinessContext, id: string, labourId: string) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const lId = parseOrThrow(uuidSchema, labourId);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const l = await tx.jobLabour.findFirst({ where: { id: lId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!l) throw Errors.notFound('Labour entry');
    await tx.jobLabour.update({ where: { id: lId }, data: { archivedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobLabourChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, metadata: { labourId: lId, change: 'removed' } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.labour_removed', summary: 'A labour entry was removed', customerId: job.customerId, vehicleId: job.vehicleId, jobId });
  });
}

/**
 * Job parts as a person is allowed to see them: selling prices for those who may see job pricing, what a part COST the workshop only for those who may see
 * costs, and (for catalogue parts) the SKU, unit and how many are available right now at the caller's locations.
 */
export async function presentJobParts<P extends { inventoryItemId: string | null; costCents: number | null; sellPriceCents: number | null }>(tx: Tx, ctx: BusinessContext, parts: P[]) {
  const pricing = can(ctx, 'job.view_pricing');
  const costs = can(ctx, 'inventory.view_costs') || can(ctx, 'finance.view_costs');
  const stock = new Map<string, { sku: string; unit: string; available: number }>();
  const itemIds = [...new Set(parts.map((p) => p.inventoryItemId).filter((v): v is string => !!v))];
  if (itemIds.length && can(ctx, 'inventory.view')) {
    const found = await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: itemIds } }, select: { id: true, sku: true, unit: true } });
    const locs = await accessibleLocations(tx, ctx);
    const totals = await stockForParts(tx, ctx.business.id, itemIds, locs.map((l) => l.id));
    for (const f of found) { const t = totalsFor(totals, f.id); stock.set(f.id, { sku: f.sku, unit: f.unit, available: availableOf(t.onHand, t.reserved) }); }
  }
  return parts.map((p) => {
    const st = p.inventoryItemId ? stock.get(p.inventoryItemId) : undefined;
    return { ...p, sellPriceCents: pricing ? p.sellPriceCents : null, costCents: pricing && costs ? p.costCents : null, catalogue: !!p.inventoryItemId, sku: st?.sku ?? null, unit: st?.unit ?? null, availableNow: st?.available ?? null };
  });
}

export async function listJobLabourAndParts(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.view');
  const jobId = parseOrThrow(uuidSchema, id);
  const pricing = can(ctx, 'job.view_pricing');
  return withTenant(ctx.business.id, async (tx) => {
    await loadJob(tx, ctx, jobId);
    const [parts, labour] = await seq([
      tx.jobPart.findMany({ where: { businessId: ctx.business.id, jobId, archivedAt: null }, orderBy: { createdAt: 'asc' } }),
      tx.jobLabour.findMany({ where: { businessId: ctx.business.id, jobId, archivedAt: null }, orderBy: { createdAt: 'asc' } }),
    ]);
    const names = await memberNames(tx, ctx.business.id, labour.map((l) => l.technicianMembershipId));
    return {
      parts: await presentJobParts(tx, ctx, parts),
      labour: labour.map((l) => ({ ...(pricing ? l : { ...l, rateCentsPerHour: null, totalCents: null }), technicianName: l.technicianMembershipId ? (names.get(l.technicianMembershipId) ?? null) : null })),
    };
  });
}
