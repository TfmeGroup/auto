import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { optionalText, parseOrThrow, uuidSchema } from '@/lib/validation';
import { Prisma, withTenant, type Tx } from '@/server/db/client';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { addCatalogueJobPart } from '@/server/inventory/jobparts';
import { jobCreateSchema, openJobTx } from '@/server/jobcards/service';
import { resolveBillableRate } from '@/server/team/labour';
import { minutesAmount } from '@/lib/money';
import { recordActivity } from '@/server/activity/service';
import type { BusinessContext } from '@/server/context';

/**
 * The service catalogue and job templates.
 *   A SERVICE is a thing the workshop sells: name, default length, default labour rate, a default price and VAT treatment, a checklist and
 *   the parts it normally uses.
 *   A JOB TEMPLATE is a recipe for opening a job. When a job is made from a template everything is COPIED onto the job (labour lines,
 *   parts, a checklist note). The job keeps no link back, so editing or archiving a template later never changes a job that already exists.
 * These are fixed configuration written by the workshop, not generated from anything.
 */

const checklistItem = z.string().trim().min(1).max(120).regex(/^[^<>\r\n]+$/, 'Use plain text');
const partLine = z.object({ partId: uuidSchema, quantity: z.coerce.number().int().min(1).max(9999) });
const cents = z.union([z.null(), z.literal(''), z.coerce.number().int().min(0).max(100_000_000)]).transform((v) => (v === '' ? null : v));

const serviceSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  description: optionalText(500),
  defaultDurationMin: z.coerce.number().int().min(5, 'At least 5 minutes').max(1440, 'At most 24 hours'),
  labourRateCentsPerHour: z.union([z.null(), z.literal(''), z.coerce.number().int().min(0).max(10_000_000)]).transform((v) => (v === '' ? null : v)),
  defaultPriceCents: cents,
  taxTreatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']),
  checklist: z.array(checklistItem).max(30),
  defaultParts: z.array(partLine).max(30),
  archived: z.boolean(),
}).partial();

export type ServiceRow = Awaited<ReturnType<Tx['serviceType']['findFirstOrThrow']>>;

const present = (s: ServiceRow, ctx: BusinessContext) => ({
  id: s.id, name: s.name, description: s.description, defaultDurationMin: s.defaultDurationMin, status: s.status, taxTreatment: s.taxTreatment, checklist: s.checklist, defaultParts: s.defaultParts as { partId: string; quantity: number }[],
  defaultPriceCents: can(ctx, 'job.view_pricing') || can(ctx, 'labour.view_rates') || can(ctx, 'quote.create') ? s.defaultPriceCents : null,
  labourRateCentsPerHour: can(ctx, 'labour.view_rates') ? s.labourRateCentsPerHour : null,
});

export async function listServiceCatalogue(ctx: BusinessContext, opts: { includeArchived?: boolean } = {}) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.serviceType.findMany({ where: { businessId: ctx.business.id, ...(opts.includeArchived ? {} : { status: 'ACTIVE' }) }, orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
    const parts = await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: rows.flatMap((r) => (r.defaultParts as { partId: string }[]).map((p) => p.partId)) } }, select: { id: true, sku: true, name: true, status: true } });
    const byId = new Map(parts.map((p) => [p.id, p]));
    return rows.map((r) => ({ ...present(r, ctx), parts: (r.defaultParts as { partId: string; quantity: number }[]).map((p) => ({ ...p, sku: byId.get(p.partId)?.sku ?? null, name: byId.get(p.partId)?.name ?? 'Removed part' })) }));
  });
}

async function assertParts(tx: Tx, businessId: string, parts: { partId: string }[]) {
  if (!parts.length) return;
  const ids = [...new Set(parts.map((p) => p.partId))];
  const found = await tx.part.count({ where: { businessId, id: { in: ids }, status: { not: 'ARCHIVED' } } });
  if (found !== ids.length) throw Errors.validation({ defaultParts: 'Choose parts from this business\'s catalogue.' });
}

/** Create (no id) or change a service. Changing a service never touches a booking, job, quote or invoice that already carries its name and price. */
export async function saveService(ctx: BusinessContext, id: string | null, input: unknown) {
  requirePermission(ctx, 'settings.manage_workshop');
  requireFeature(ctx.subscription, 'advanced_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(serviceSchema, input);
  if (!id && !d.name) throw Errors.validation({ name: 'Enter a name' });
  if (d.labourRateCentsPerHour !== undefined) requirePermission(ctx, 'labour.manage_rates');
  return withTenant(ctx.business.id, async (tx) => {
    if (d.defaultParts) await assertParts(tx, ctx.business.id, d.defaultParts);
    const before = id ? await tx.serviceType.findFirst({ where: { id: parseOrThrow(uuidSchema, id), businessId: ctx.business.id } }) : null;
    if (id && !before) throw Errors.notFound('Service');
    if (d.name !== undefined) {
      const dup = await tx.serviceType.findFirst({ where: { businessId: ctx.business.id, status: 'ACTIVE', name: { equals: d.name, mode: 'insensitive' }, ...(before ? { id: { not: before.id } } : {}) } });
      if (dup) throw Errors.validation({ name: 'You already have a service with this name.' });
    }
    const { archived, ...rest } = d;
    const data = { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(archived !== undefined ? { status: archived ? 'ARCHIVED' : 'ACTIVE' } : {}) } as Prisma.ServiceTypeUncheckedUpdateInput;
    const after = before
      ? await tx.serviceType.update({ where: { id: before.id }, data })
      : await tx.serviceType.create({ data: { ...(data as Prisma.ServiceTypeUncheckedCreateInput), name: d.name!, businessId: ctx.business.id, defaultDurationMin: d.defaultDurationMin ?? 60 } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.serviceCatalogueChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'service_type', resourceId: after.id, before: before ? present(before, ctx) : undefined, after: present(after, ctx) });
    return present(after, ctx);
  });
}

/**
 * A ready-to-use quote/invoice line for a service, from its default price and VAT treatment. The line is a COPY: the document keeps the
 * price it was given even if the service's price changes tomorrow.
 */
export async function serviceLine(ctx: BusinessContext, id: string) {
  if (!can(ctx, 'quote.create') && !can(ctx, 'invoice.create')) throw Errors.forbidden();
  return withTenant(ctx.business.id, async (tx) => {
    const s = await tx.serviceType.findFirst({ where: { id: parseOrThrow(uuidSchema, id), businessId: ctx.business.id, status: 'ACTIVE' } });
    if (!s) throw Errors.notFound('Service');
    if (s.defaultPriceCents === null) throw Errors.conflict('This service has no default price. Set one in Settings, Services, or type the price on the document.');
    return { lineType: 'SERVICE', description: s.name, quantityMilli: 1000, unitPriceCents: s.defaultPriceCents, taxTreatment: s.taxTreatment };
  });
}

/** The services that have a default price, for the quote and invoice forms (anyone who writes those documents may read them). */
export async function listPricedServices(ctx: BusinessContext) {
  if (!can(ctx, 'quote.create') && !can(ctx, 'invoice.create')) return [];
  return withTenant(ctx.business.id, async (tx) =>
    (await tx.serviceType.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE', defaultPriceCents: { not: null } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, defaultPriceCents: true, taxTreatment: true } }))
      .map((s) => ({ id: s.id, name: s.name, priceCents: s.defaultPriceCents!, taxTreatment: s.taxTreatment as string })));
}

// ───────────────────────── job templates ─────────────────────────

const labourLine = z.object({ description: z.string().trim().min(1).max(200), minutes: z.coerce.number().int().min(1).max(1440) });
const templateSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  description: optionalText(500),
  serviceTypeId: z.union([z.null(), z.literal(''), uuidSchema]).transform((v) => (v === '' ? null : v)),
  estimatedMinutes: z.union([z.null(), z.literal(''), z.coerce.number().int().min(5).max(10_080)]).transform((v) => (v === '' ? null : v)),
  checklist: z.array(checklistItem).max(40),
  inspectionFields: z.array(checklistItem).max(40),
  labour: z.array(labourLine).max(30),
  parts: z.array(partLine).max(30),
  archived: z.boolean(),
}).partial();

export type TemplateRow = Awaited<ReturnType<Tx['jobTemplate']['findFirstOrThrow']>>;
const presentTemplate = (t: TemplateRow) => ({
  id: t.id, name: t.name, description: t.description, serviceTypeId: t.serviceTypeId, estimatedMinutes: t.estimatedMinutes, checklist: t.checklist, inspectionFields: t.inspectionFields,
  labour: t.labour as { description: string; minutes: number }[], parts: t.parts as { partId: string; quantity: number }[], status: t.status, updatedAt: t.updatedAt,
});

export async function listJobTemplates(ctx: BusinessContext, opts: { includeArchived?: boolean } = {}) {
  requirePermission(ctx, 'job.view');
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.jobTemplate.findMany({ where: { businessId: ctx.business.id, ...(opts.includeArchived ? {} : { status: 'ACTIVE' }) }, orderBy: [{ status: 'asc' }, { name: 'asc' }], include: { service: { select: { name: true } } } });
    return rows.map((t) => ({ ...presentTemplate(t), serviceName: t.service?.name ?? null }));
  });
}

export async function saveJobTemplate(ctx: BusinessContext, id: string | null, input: unknown) {
  requirePermission(ctx, 'settings.manage_workshop');
  requireFeature(ctx.subscription, 'advanced_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(templateSchema, input);
  if (!id && !d.name) throw Errors.validation({ name: 'Enter a name' });
  return withTenant(ctx.business.id, async (tx) => {
    if (d.parts) await assertParts(tx, ctx.business.id, d.parts);
    if (d.serviceTypeId) {
      const s = await tx.serviceType.findFirst({ where: { id: d.serviceTypeId, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } });
      if (!s) throw Errors.validation({ serviceTypeId: 'Choose a service of this business.' });
    }
    const before = id ? await tx.jobTemplate.findFirst({ where: { id: parseOrThrow(uuidSchema, id), businessId: ctx.business.id } }) : null;
    if (id && !before) throw Errors.notFound('Template');
    if (d.name !== undefined) {
      const dup = await tx.jobTemplate.findFirst({ where: { businessId: ctx.business.id, status: 'ACTIVE', name: { equals: d.name, mode: 'insensitive' }, ...(before ? { id: { not: before.id } } : {}) } });
      if (dup) throw Errors.validation({ name: 'You already have a template with this name.' });
    }
    const { archived, ...rest } = d;
    const data = { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(archived !== undefined ? { status: archived ? 'ARCHIVED' : 'ACTIVE' } : {}) } as Prisma.JobTemplateUncheckedUpdateInput;
    const after = before
      ? await tx.jobTemplate.update({ where: { id: before.id }, data })
      : await tx.jobTemplate.create({ data: { ...(data as Prisma.JobTemplateUncheckedCreateInput), name: d.name!, businessId: ctx.business.id, createdById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobTemplateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job_template', resourceId: after.id, before: before ? presentTemplate(before) : undefined, after: presentTemplate(after) });
    return presentTemplate(after);
  });
}

const fromTemplateSchema = jobCreateSchema.and(z.object({ templateId: uuidSchema }));

/**
 * Open a job from a template. The job is opened exactly as any other (same rules, numbering and checks), then the template's content is COPIED
 * onto it: labour lines at the rate in force now, catalogue parts (reserved when the business works that way), and the checklist as an internal
 * note. The job holds no reference to the template afterwards.
 */
export async function createJobFromTemplate(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'job.create');
  requireFeature(ctx.subscription, 'advanced_settings');
  const { templateId, ...data } = parseOrThrow(fromTemplateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const t = await tx.jobTemplate.findFirst({ where: { id: templateId, businessId: ctx.business.id, status: 'ACTIVE' } });
    if (!t) throw Errors.notFound('Template');
    const labour = t.labour as { description: string; minutes: number }[];
    const parts = t.parts as { partId: string; quantity: number }[];
    if ((labour.length || parts.length) && !can(ctx, 'job.edit')) throw Errors.forbidden('This template adds labour and parts to the job, which needs permission to edit jobs.');
    const opened = await openJobTx(ctx, tx, {
      ...data, serviceTypeId: data.serviceTypeId ?? t.serviceTypeId ?? undefined,
      estimatedCompletionAt: data.estimatedCompletionAt ?? (t.estimatedMinutes && data.arrived ? new Date(Date.now() + t.estimatedMinutes * 60_000) : undefined),
    });
    const job = opened.job;
    if (!opened.created) return { ...opened, copied: { labour: 0, parts: 0, checklist: 0, skippedParts: 0 } };
    const tech = job.primaryTechnicianMembershipId ?? ctx.membership.id;
    for (const l of labour) {
      const rate = (await resolveBillableRate(tx, ctx.business.id, { membershipId: tech, serviceTypeId: job.serviceTypeId })).rateCentsPerHour;
      await tx.jobLabour.create({ data: { businessId: ctx.business.id, jobId: job.id, technicianMembershipId: tech, description: l.description, minutes: l.minutes, rateCentsPerHour: rate, totalCents: rate != null ? minutesAmount(l.minutes, rate) : null, recordedById: ctx.user.id } });
    }
    let skipped = 0;
    for (const p of parts) {
      const live = await tx.part.findFirst({ where: { id: p.partId, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } });
      if (!live) { skipped++; continue; }
      await addCatalogueJobPart(tx, ctx, job, { inventoryItemId: p.partId, quantity: p.quantity });
    }
    const lines = [...t.checklist.map((c) => `[ ] ${c}`), ...t.inspectionFields.map((c) => `[ ] Inspect: ${c}`)];
    if (lines.length) await tx.jobNote.create({ data: { businessId: ctx.business.id, jobId: job.id, body: `Checklist (from template "${t.name}")\n${lines.join('\n')}`, visibility: 'INTERNAL', authorId: ctx.user.id } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.template_applied', summary: `Job opened from template "${t.name}"`, customerId: job.customerId, vehicleId: job.vehicleId, jobId: job.id });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobTemplateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: job.id, metadata: { appliedTemplate: t.name, labourLines: labour.length, partLines: parts.length - skipped } });
    return { ...opened, copied: { labour: labour.length, parts: parts.length - skipped, checklist: lines.length, skippedParts: skipped } };
  });
}
