import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { optionalText, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { can, requirePermission } from '@/server/permissions/authorize';
import { memberNames } from '@/server/workshop/people';
import { loadJob, loadJobForWrite } from './common';
import { applyStatusTx } from './service';
import { INSPECTION_TEMPLATE } from './transitions';
import type { BusinessContext } from '@/server/context';

/**
 * The technician's record of what they found and what they recommend, kept as three separate things on purpose:
 *   1. Inspection — item-by-item observations (Good / Attention / Critical).
 *   2. Diagnosis  — symptoms, tests and findings (OBSERVATIONS) kept apart from the technician's stated conclusion,
 *                   which only counts as "confirmed" when someone presses confirm.
 *   3. Recommended work — a proposal, with its own approval state. A finding never approves a repair.
 */

// ───────────────────────── inspection ─────────────────────────

const itemStatus = z.enum(['NOT_CHECKED', 'GOOD', 'ATTENTION', 'CRITICAL']);

/** A measurement such as 4.5 (mm) or 220 (kPa), stored as tenths so it stays an integer. */
const measurement = z.union([z.literal(''), z.null(), z.coerce.number().min(0).max(100_000)]).optional()
  .transform((v) => (v === '' || v === null || v === undefined ? (v === undefined ? undefined : null) : Math.round(v * 10)));

export const inspectionItemUpdateSchema = z.object({
  status: itemStatus.optional(),
  internalNotes: optionalText(2000),
  customerNotes: optionalText(2000),
  measurement,
  measurementUnit: optionalText(10),
  customerVisible: z.boolean().optional(),
});

export const inspectionItemAddSchema = z.object({
  category: z.enum(['EXTERIOR', 'TYRES_WHEELS', 'MECHANICAL', 'OTHER']),
  label: z.string().trim().min(1, 'Enter what is being inspected').max(80),
});

async function inspectionFor(tx: Parameters<Parameters<typeof withTenant>[1]>[0], businessId: string, jobId: string) {
  const i = await tx.inspection.findFirst({ where: { jobId, businessId } });
  if (!i) throw Errors.notFound('Inspection');
  return i;
}

/**
 * Start the job's inspection from the standard checklist (idempotent: a second call returns the same inspection).
 * Starting it on a job that has only just been checked in moves the job on to Inspection, as the workflow expects.
 */
export async function startInspection(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    if (job.status === 'BOOKED') throw Errors.conflict('Check the vehicle in before inspecting it.');
    const existing = await tx.inspection.findFirst({ where: { jobId, businessId: ctx.business.id } });
    if (existing) return existing;

    const inspection = await tx.inspection.create({
      data: {
        businessId: ctx.business.id, jobId, vehicleId: job.vehicleId, customerId: job.customerId,
        technicianMembershipId: ctx.membership.id, mileageKm: job.mileageInKm, createdById: ctx.user.id,
      },
    });
    await tx.inspectionItem.createMany({
      data: INSPECTION_TEMPLATE.map((t, i) => ({
        businessId: ctx.business.id, inspectionId: inspection.id, category: t.category, itemKey: t.key, label: t.label, sortOrder: i * 10, measurementUnit: t.unit ?? null,
      })),
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.inspectionStarted, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'inspection', resourceId: inspection.id, metadata: { jobId },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'inspection.started', summary: 'Inspection started', customerId: job.customerId, vehicleId: job.vehicleId, jobId,
    });
    if (job.status === 'CHECKED_IN') await applyStatusTx(tx, ctx, job, 'INSPECTION', { reason: 'Inspection started', action: 'inspection_started' });
    return inspection;
  });
}

export async function updateInspectionItem(ctx: BusinessContext, id: string, itemId: string, input: unknown) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const iId = parseOrThrow(uuidSchema, itemId);
  const d = parseOrThrow(inspectionItemUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const inspection = await inspectionFor(tx, ctx.business.id, jobId);
    const before = await tx.inspectionItem.findFirst({ where: { id: iId, inspectionId: inspection.id, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Inspection item');
    const patch = Object.fromEntries(Object.entries({
      status: d.status, internalNotes: d.internalNotes, customerNotes: d.customerNotes, measurementTenths: d.measurement,
      measurementUnit: d.measurementUnit, customerVisible: d.customerVisible,
    }).filter(([, v]) => v !== undefined));
    const after = await tx.inspectionItem.update({ where: { id: iId }, data: { ...patch, updatedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.inspectionUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'inspection', resourceId: inspection.id,
      before: { item: before.label, status: before.status, customerVisible: before.customerVisible }, after: { item: after.label, status: after.status, customerVisible: after.customerVisible },
    });
    if (d.status !== undefined && d.status !== before.status) {
      await recordActivity(tx, ctx.business.id, ctx.user.id, {
        type: 'inspection.item_recorded', summary: `${before.label}: ${d.status.toLowerCase().replace('_', ' ')}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
      });
    }
    return after;
  });
}

export async function addInspectionItem(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(inspectionItemAddSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await loadJobForWrite(tx, ctx, jobId);
    const inspection = await inspectionFor(tx, ctx.business.id, jobId);
    const max = await tx.inspectionItem.aggregate({ where: { inspectionId: inspection.id, businessId: ctx.business.id }, _max: { sortOrder: true } });
    const key = `custom_${Date.now().toString(36)}`;
    const item = await tx.inspectionItem.create({
      data: { businessId: ctx.business.id, inspectionId: inspection.id, category: d.category, itemKey: key, label: d.label, sortOrder: (max._max.sortOrder ?? 0) + 10 },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.inspectionUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'inspection', resourceId: inspection.id, metadata: { itemAdded: d.label },
    });
    return item;
  });
}

export const inspectionSummarySchema = z.object({ internalNotes: optionalText(4000), customerSummary: optionalText(4000) });

export async function updateInspectionNotes(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(inspectionSummarySchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await loadJobForWrite(tx, ctx, jobId);
    const inspection = await inspectionFor(tx, ctx.business.id, jobId);
    const after = await tx.inspection.update({ where: { id: inspection.id }, data: { ...(d.internalNotes !== undefined ? { internalNotes: d.internalNotes } : {}), ...(d.customerSummary !== undefined ? { customerSummary: d.customerSummary } : {}) } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.inspectionUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'inspection', resourceId: inspection.id, metadata: { notesChanged: true } });
    return after;
  });
}

export async function completeInspection(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const inspection = await inspectionFor(tx, ctx.business.id, jobId);
    if (inspection.status === 'COMPLETED') return inspection;
    const items = await tx.inspectionItem.findMany({ where: { inspectionId: inspection.id, businessId: ctx.business.id } });
    const checked = items.filter((i) => i.status !== 'NOT_CHECKED');
    if (checked.length === 0) throw Errors.conflict('Record at least one inspection item before completing the inspection.');
    const after = await tx.inspection.update({ where: { id: inspection.id }, data: { status: 'COMPLETED', completedAt: new Date(), completedById: ctx.user.id, technicianMembershipId: inspection.technicianMembershipId ?? ctx.membership.id } });
    const critical = checked.filter((i) => i.status === 'CRITICAL').length;
    const attention = checked.filter((i) => i.status === 'ATTENTION').length;
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.inspectionCompleted, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'inspection', resourceId: inspection.id,
      metadata: { jobId, checked: checked.length, critical, attention },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'inspection.completed', summary: `Inspection completed: ${critical} critical, ${attention} need attention`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
      data: { critical, attention },
    });
    return after;
  });
}

// ───────────────────────── diagnosis ─────────────────────────

const faultCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9\-.]{2,11}$/, 'Fault codes look like P0301 or U0100');

export const diagnosisSchema = z.object({
  symptoms: optionalText(2000),
  faultCodes: z.array(faultCode).max(20).optional(),
  testsPerformed: optionalText(2000),
  findings: optionalText(4000),
  diagnosis: optionalText(2000),
  internalNotes: optionalText(4000),
  customerSummary: optionalText(2000),
});

export async function createDiagnosis(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(diagnosisSchema, input);
  if (!d.symptoms && !d.findings && !d.testsPerformed && !d.diagnosis && !(d.faultCodes?.length)) {
    throw Errors.validation({ findings: 'Record at least one symptom, test, finding or fault code.' });
  }
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    if (job.status === 'BOOKED') throw Errors.conflict('Check the vehicle in before recording a diagnosis.');
    const row = await tx.diagnosis.create({
      data: {
        businessId: ctx.business.id, jobId, vehicleId: job.vehicleId, customerId: job.customerId, technicianMembershipId: ctx.membership.id,
        symptoms: d.symptoms ?? null, faultCodes: d.faultCodes ?? [], testsPerformed: d.testsPerformed ?? null, findings: d.findings ?? null,
        diagnosis: d.diagnosis ?? null, internalNotes: d.internalNotes ?? null, customerSummary: d.customerSummary ?? null, createdById: ctx.user.id,
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.diagnosisRecorded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'diagnosis', resourceId: row.id, metadata: { jobId } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'diagnosis.recorded', summary: `Diagnostic record added${d.faultCodes?.length ? ` (${d.faultCodes.join(', ')})` : ''}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
    });
    return row;
  });
}

export async function updateDiagnosis(ctx: BusinessContext, id: string, diagnosisId: string, input: unknown) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const dId = parseOrThrow(uuidSchema, diagnosisId);
  const d = parseOrThrow(diagnosisSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const before = await tx.diagnosis.findFirst({ where: { id: dId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!before) throw Errors.notFound('Diagnosis');
    const patch = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
    // Changing the stated conclusion withdraws its confirmation: it must be confirmed again on purpose.
    const conclusionChanged = d.diagnosis !== undefined && d.diagnosis !== before.diagnosis;
    const after = await tx.diagnosis.update({ where: { id: dId }, data: { ...patch, ...(conclusionChanged ? { confirmedAt: null, confirmedById: null } : {}) } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.diagnosisUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'diagnosis', resourceId: dId, before, after, metadata: { jobId } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'diagnosis.updated', summary: 'Diagnostic record updated', customerId: job.customerId, vehicleId: job.vehicleId, jobId });
    return after;
  });
}

/** An explicit act: "this is the diagnosis". Observations alone never become a confirmed diagnosis. */
export async function confirmDiagnosis(ctx: BusinessContext, id: string, diagnosisId: string) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const dId = parseOrThrow(uuidSchema, diagnosisId);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const row = await tx.diagnosis.findFirst({ where: { id: dId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!row) throw Errors.notFound('Diagnosis');
    if (!row.diagnosis) throw Errors.validation({ diagnosis: 'Write the diagnosis before confirming it. Findings alone are observations, not a diagnosis.' });
    if (row.confirmedAt) return row;
    const after = await tx.diagnosis.update({ where: { id: dId }, data: { confirmedAt: new Date(), confirmedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.diagnosisConfirmed, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'diagnosis', resourceId: dId, metadata: { jobId } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'diagnosis.confirmed', summary: 'Diagnosis confirmed by technician', customerId: job.customerId, vehicleId: job.vehicleId, jobId });
    return after;
  });
}

/** Diagnostic history for a vehicle (the Diagnostics tab). */
export async function listVehicleDiagnostics(ctx: BusinessContext, vehicleId: string) {
  requirePermission(ctx, 'vehicle.view');
  requirePermission(ctx, 'job.view');
  const vId = parseOrThrow(uuidSchema, vehicleId);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vId, businessId: ctx.business.id }, select: { id: true } });
    if (!v) throw Errors.notFound('Vehicle');
    const rows = await tx.diagnosis.findMany({ where: { businessId: ctx.business.id, vehicleId: vId, archivedAt: null }, orderBy: { recordedAt: 'desc' }, take: 100, include: { job: { select: { jobNumber: true } } } });
    const names = await memberNames(tx, ctx.business.id, rows.map((r) => r.technicianMembershipId));
    return rows.map((r) => ({ ...r, jobNumber: r.job.jobNumber, technicianName: r.technicianMembershipId ? (names.get(r.technicianMembershipId) ?? null) : null }));
  });
}

// ───────────────────────── recommended work ─────────────────────────

const cents = z.union([z.literal(''), z.null(), z.coerce.number().int('Enter whole cents').min(0).max(1_000_000_000)]).optional().transform((v) => (v === '' ? null : v));

const workShape = {
  description: z.string().trim().min(1, 'Describe the work').max(300),
  priority: z.enum(['RECOMMENDED', 'IMPORTANT', 'URGENT']),
  quantity: z.coerce.number().int().min(1).max(999),
  partsDescription: optionalText(500),
  estimatedMinutes: z.union([z.literal(''), z.null(), z.coerce.number().int().min(0).max(100_000)]).optional().transform((v) => (v === '' ? null : v)),
  estimatedLabourCents: cents,
  estimatedPartsCents: cents,
  notes: optionalText(2000),
  customerVisible: z.boolean(),
  sourceInspectionItemId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  sourceDiagnosisId: z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
};
export const workSchema = z.object({ ...workShape, priority: workShape.priority.default('RECOMMENDED'), quantity: workShape.quantity.default(1), customerVisible: workShape.customerVisible.default(true) });
// Updates must not inherit the create defaults (editing a note must not reset the priority).
const workUpdateSchema = z.object(workShape).partial();

function requirePricingIfSet(ctx: BusinessContext, d: { estimatedLabourCents?: number | null; estimatedPartsCents?: number | null }) {
  if ((d.estimatedLabourCents != null || d.estimatedPartsCents != null) && !can(ctx, 'job.view_pricing')) {
    throw Errors.forbidden('You do not have permission to enter prices.');
  }
}

export async function createRecommendedWork(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(workSchema, input);
  requirePricingIfSet(ctx, d);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    if (job.status === 'BOOKED') throw Errors.conflict('Check the vehicle in first.');
    let sourceType: 'MANUAL' | 'INSPECTION_ITEM' | 'DIAGNOSIS' = 'MANUAL';
    if (d.sourceInspectionItemId) {
      const item = await tx.inspectionItem.findFirst({ where: { id: d.sourceInspectionItemId, businessId: ctx.business.id, inspection: { jobId } } });
      if (!item) throw Errors.validation({ sourceInspectionItemId: 'That finding is not part of this job.' });
      sourceType = 'INSPECTION_ITEM';
    } else if (d.sourceDiagnosisId) {
      const dg = await tx.diagnosis.findFirst({ where: { id: d.sourceDiagnosisId, businessId: ctx.business.id, jobId } });
      if (!dg) throw Errors.validation({ sourceDiagnosisId: 'That diagnosis is not part of this job.' });
      sourceType = 'DIAGNOSIS';
    }
    const row = await tx.recommendedWork.create({
      data: {
        businessId: ctx.business.id, jobId, description: d.description, sourceType, priority: d.priority, quantity: d.quantity,
        sourceInspectionItemId: d.sourceInspectionItemId ?? null, sourceDiagnosisId: d.sourceDiagnosisId ?? null,
        partsDescription: d.partsDescription ?? null, estimatedMinutes: d.estimatedMinutes ?? null, estimatedLabourCents: d.estimatedLabourCents ?? null,
        estimatedPartsCents: d.estimatedPartsCents ?? null, notes: d.notes ?? null, customerVisible: d.customerVisible, createdById: ctx.user.id,
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.recommendedWorkChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'recommended_work', resourceId: row.id, metadata: { jobId, change: 'created', priority: row.priority } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'work.recommended', summary: `Recommended (${d.priority.toLowerCase()}): ${d.description}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
    });
    return row;
  });
}

export async function updateRecommendedWork(ctx: BusinessContext, id: string, workId: string, input: unknown) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const wId = parseOrThrow(uuidSchema, workId);
  const d = parseOrThrow(workUpdateSchema, input);
  requirePricingIfSet(ctx, d);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const before = await tx.recommendedWork.findFirst({ where: { id: wId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!before) throw Errors.notFound('Recommended work');
    if (before.completedAt) throw Errors.conflict('This work has been completed and can no longer be edited.');
    const { sourceInspectionItemId: _a, sourceDiagnosisId: _b, ...fields } = d;
    void _a; void _b;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
    // The customer decided on the work as it was described. Changing what it is, its priority or its price
    // withdraws that decision so it has to be made again.
    const material = ['description', 'priority', 'quantity', 'estimatedLabourCents', 'estimatedPartsCents', 'partsDescription'].some((k) => patch[k] !== undefined && patch[k] !== (before as Record<string, unknown>)[k]);
    const reset = material && before.approvalStatus !== 'PENDING';
    const after = await tx.recommendedWork.update({
      where: { id: wId },
      data: { ...patch, ...(reset ? { approvalStatus: 'PENDING', approvalMethod: null, decidedAt: null, decidedById: null, decisionNote: null } : {}) },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.recommendedWorkChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'recommended_work', resourceId: wId, before, after, metadata: { jobId, change: 'updated', decisionReset: reset } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'work.updated', summary: `Recommended work changed: ${after.description}${reset ? ' (decision withdrawn, needs approval again)' : ''}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
    });
    return after;
  });
}

export async function removeRecommendedWork(ctx: BusinessContext, id: string, workId: string) {
  requirePermission(ctx, 'job.inspect');
  const jobId = parseOrThrow(uuidSchema, id);
  const wId = parseOrThrow(uuidSchema, workId);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const w = await tx.recommendedWork.findFirst({ where: { id: wId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!w) throw Errors.notFound('Recommended work');
    if (w.completedAt) throw Errors.conflict('Completed work cannot be removed.');
    await tx.recommendedWork.update({ where: { id: wId }, data: { archivedAt: new Date() } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.recommendedWorkChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'recommended_work', resourceId: wId, metadata: { jobId, change: 'removed' } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'work.removed', summary: `Recommended work removed: ${w.description}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId });
  });
}

export const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'DECLINED', 'PENDING']),
  method: z.enum(['IN_PERSON', 'PHONE', 'WRITTEN', 'OTHER']).optional(),
  note: optionalText(500),
});

/**
 * Record the customer's decision on a piece of recommended work (the quote workflow of Part 4 will drive this same
 * state). Only people allowed to record approval can do it, and it never happens as a side effect of anything else.
 */
export async function decideRecommendedWork(ctx: BusinessContext, id: string, workId: string, input: unknown) {
  requirePermission(ctx, 'job.approve_work');
  const jobId = parseOrThrow(uuidSchema, id);
  const wId = parseOrThrow(uuidSchema, workId);
  const d = parseOrThrow(decisionSchema, input);
  if (d.decision !== 'PENDING' && !d.method) throw Errors.validation({ method: 'Record how the customer told you (in person, phone, in writing).' });
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId, { skipAssignment: true });
    if (!['AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'].includes(job.status)) {
      throw Errors.conflict('Decisions are recorded once the job is awaiting approval.');
    }
    const before = await tx.recommendedWork.findFirst({ where: { id: wId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!before) throw Errors.notFound('Recommended work');
    if (before.completedAt) throw Errors.conflict('This work has already been completed.');
    const after = await tx.recommendedWork.update({
      where: { id: wId },
      data: d.decision === 'PENDING'
        ? { approvalStatus: 'PENDING', approvalMethod: null, decidedAt: null, decidedById: null, decisionNote: null }
        : { approvalStatus: d.decision, approvalMethod: d.method, decidedAt: new Date(), decidedById: ctx.user.id, decisionNote: d.note ?? null },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.recommendedWorkDecision, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'recommended_work', resourceId: wId,
      before: { approvalStatus: before.approvalStatus }, after: { approvalStatus: after.approvalStatus }, metadata: { jobId, method: d.method, note: d.note },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'work.decision', summary: `${after.description}: ${d.decision.toLowerCase()}${d.method ? ` (${d.method.toLowerCase().replace('_', ' ')})` : ''}`,
      customerId: job.customerId, vehicleId: job.vehicleId, jobId, data: { decision: d.decision },
    });
    return after;
  });
}

export async function listRecommendedWork(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.view');
  const jobId = parseOrThrow(uuidSchema, id);
  const pricing = can(ctx, 'job.view_pricing');
  return withTenant(ctx.business.id, async (tx) => {
    await loadJob(tx, ctx, jobId);
    const rows = await tx.recommendedWork.findMany({ where: { businessId: ctx.business.id, jobId, archivedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map((w) => (pricing ? w : { ...w, estimatedLabourCents: null, estimatedPartsCents: null }));
  });
}
