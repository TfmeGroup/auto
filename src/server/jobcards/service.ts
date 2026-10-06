import { z } from 'zod';
import { seq, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { dayRange } from '@/lib/tz';
import { escapeLike, optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { messageJob, onJobStatusChanged } from './notify';
import { nextJobNumber } from '@/server/numbering/sequence';
import { can, requirePermission } from '@/server/permissions/authorize';
import { addBookingEvent, bookingFilterSchema, lockBooking } from '@/server/bookings/service';
import { markServiced } from '@/server/vehicles/insights';
import { applyWorkflowVehicleStatus, recordMileageTx, vehicleLabel } from '@/server/vehicles/service';
import { assertActiveMember, assertAssignableTechnician, assertLocation, locationWhere, memberNames, visibleLocationIds } from '@/server/workshop/people';
import { loadRules } from '@/server/workshop/service';
import { loadConfig } from '@/server/settings/config';
import { assertJobRequirements } from '@/server/settings/config-service';
import { assertNoPhantomReservations, releaseJobReservations } from '@/server/inventory/jobparts';
import { presentJobParts } from './items';
import { recordAssignmentChanges } from '@/server/team/assignments';
import { loadJob, loadJobForWrite, type JobRow } from './common';
import { JOB_STATUSES, JOB_STATUS_LABEL, QUALITY_CHECKLIST, decideTransition, isOpen, nextStatuses, type JobStatus } from './transitions';
import type { BusinessContext } from '@/server/context';

const optionalUuid = z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined));
const nullableUuid = z.union([z.null(), z.literal(''), uuidSchema]).optional().transform((v) => (v === '' ? null : v));
const optionalKm = z.union([z.literal(''), z.coerce.number().int('Enter whole kilometres').min(0).max(5_000_000)]).optional().transform((v) => (v === '' ? undefined : v));
const optionalDate = z.union([z.literal(''), z.coerce.date()]).optional().transform((v) => (v === '' ? undefined : v));
const priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const fuel = z.union([z.literal(''), z.enum(['EMPTY', 'QUARTER', 'HALF', 'THREE_QUARTERS', 'FULL'])]).optional().transform((v) => (v ? v : undefined));

const checkInFields = {
  fuelLevel: fuel,
  existingDamage: optionalText(2000),
  vehicleCondition: optionalText(2000),
  keysAccessories: optionalText(500),
  checkInNotes: optionalText(2000),
  signatureName: optionalText(120),
};

export const jobCreateSchema = z.object({
  bookingId: optionalUuid,
  customerId: optionalUuid,
  vehicleId: optionalUuid,
  serviceTypeId: optionalUuid,
  serviceLabel: optionalText(80),
  complaint: optionalText(2000),
  priority: priority.default('NORMAL'),
  mileageKm: optionalKm,
  primaryTechnicianMembershipId: optionalUuid,
  advisorMembershipId: optionalUuid,
  locationId: optionalUuid,
  bayId: optionalUuid,
  estimatedCompletionAt: optionalDate,
  isWalkIn: z.boolean().default(false),
  /** false = open the job before the vehicle has arrived (only for a booking); it starts as Booked. */
  arrived: z.boolean().default(true),
  ...checkInFields,
});

export const jobUpdateSchema = z.object({
  complaint: optionalText(2000),
  serviceTypeId: optionalUuid,
  serviceLabel: optionalText(80),
  priority: priority.optional(),
  estimatedCompletionAt: z.union([z.null(), z.literal(''), z.coerce.date()]).optional().transform((v) => (v === '' ? null : v)),
  locationId: nullableUuid,
  bayId: nullableUuid,
  advisorMembershipId: nullableUuid,
});

// ───────────────────────── opening a job ─────────────────────────

interface CheckInDetails {
  mileageKm?: number;
  fuelLevel?: string;
  existingDamage?: string;
  vehicleCondition?: string;
  keysAccessories?: string;
  checkInNotes?: string;
  signatureName?: string;
}

/** Record the vehicle's arrival on a job (arrival time, odometer, fuel, damage, keys, optional confirmation). */
async function recordCheckIn(tx: Tx, ctx: BusinessContext, job: JobRow, d: CheckInDetails) {
  const rules = await loadRules(tx, ctx.business.id);
  if (rules.requireCheckInSignature && !d.signatureName) {
    throw Errors.validation({ signatureName: 'This workshop requires the customer to confirm the check-in. Enter their name.' });
  }
  const now = new Date();
  await tx.jobCheckIn.create({
    data: {
      businessId: ctx.business.id, jobId: job.id, arrivedAt: now, mileageKm: d.mileageKm ?? null, fuelLevel: (d.fuelLevel as never) ?? null,
      existingDamage: d.existingDamage ?? null, vehicleCondition: d.vehicleCondition ?? null, keysAccessories: d.keysAccessories ?? null,
      notes: d.checkInNotes ?? null, signatureName: d.signatureName ?? null, signedAt: d.signatureName ? now : null, checkedInById: ctx.user.id,
    },
  });
  if (d.mileageKm !== undefined) {
    await recordMileageTx(tx, ctx.business.id, ctx.user.id, job.vehicleId, d.mileageKm, 'CHECK_IN', { jobId: job.id });
    await tx.jobCard.update({ where: { id: job.id }, data: { mileageInKm: d.mileageKm } });
  }
  await recordAudit(tx, ctx.meta, {
    action: AuditActions.jobCheckedIn, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: job.id,
    metadata: { mileageKm: d.mileageKm, fuelLevel: d.fuelLevel, signed: !!d.signatureName },
  });
  await recordActivity(tx, ctx.business.id, ctx.user.id, {
    type: 'job.checked_in', summary: `Vehicle checked in${d.mileageKm !== undefined ? ` at ${d.mileageKm.toLocaleString('en-ZA')} km` : ''}`,
    customerId: job.customerId, vehicleId: job.vehicleId, jobId: job.id,
  });
}

/** Link a booking to its job: booking becomes Checked In (idempotent: already-linked bookings are untouched). */
async function markBookingCheckedIn(tx: Tx, ctx: BusinessContext, bookingId: string, jobNumber: string) {
  const b = await tx.booking.findFirstOrThrow({ where: { id: bookingId, businessId: ctx.business.id } });
  if (b.status === 'CHECKED_IN') return;
  await tx.booking.update({ where: { id: bookingId }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });
  await addBookingEvent(tx, ctx.business.id, bookingId, ctx.user.id, { type: 'checked_in', fromStatus: b.status, toStatus: 'CHECKED_IN', reason: `Job ${jobNumber}` });
  await recordAudit(tx, ctx.meta, {
    action: AuditActions.bookingCheckedIn, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'booking', resourceId: bookingId,
    before: { status: b.status }, after: { status: 'CHECKED_IN' }, metadata: { jobNumber },
  });
  await recordActivity(tx, ctx.business.id, ctx.user.id, {
    type: 'booking.checked_in', summary: `Booking ${b.bookingNumber} checked in (job ${jobNumber})`, customerId: b.customerId, vehicleId: b.vehicleId, bookingId, jobId: undefined,
  });
}

export interface OpenJobResult { job: JobRow; created: boolean }

/**
 * Open a job card: from a booking (carrying its details across), or directly for a customer and vehicle (a walk-in
 * needs no booking). Opening the SAME booking twice returns the job that already exists, so a double click or two
 * receptionists checking in together can never create two jobs.
 */
export async function openJobTx(ctx: BusinessContext, tx: Tx, data: z.output<typeof jobCreateSchema>): Promise<OpenJobResult> {
  const businessId = ctx.business.id;
  const checkIn: CheckInDetails = {
    mileageKm: data.mileageKm, fuelLevel: data.fuelLevel, existingDamage: data.existingDamage, vehicleCondition: data.vehicleCondition,
    keysAccessories: data.keysAccessories, checkInNotes: data.checkInNotes, signatureName: data.signatureName,
  };

  let booking: Awaited<ReturnType<Tx['booking']['findFirstOrThrow']>> | null = null;
  if (data.bookingId) {
    booking = await lockBooking(tx, ctx, data.bookingId);
    const existing = await tx.jobCard.findFirst({ where: { businessId, bookingId: booking.id } });
    if (existing) {
      if (existing.status === 'BOOKED' && data.arrived) {
        await recordCheckIn(tx, ctx, existing, checkIn);
        const job = await applyStatusTx(tx, ctx, existing, 'CHECKED_IN', { reason: 'Vehicle arrived' });
        await markBookingCheckedIn(tx, ctx, booking.id, job.jobNumber);
        return { job, created: false };
      }
      return { job: existing, created: false };
    }
    if (!['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'RESCHEDULED'].includes(booking.status)) {
      throw Errors.conflict(`A ${booking.status.toLowerCase().replace('_', ' ')} booking cannot be turned into a job.`);
    }
    if ((data.customerId && data.customerId !== booking.customerId) || (data.vehicleId && data.vehicleId !== booking.vehicleId)) {
      throw Errors.validation({ bookingId: 'That booking is for a different customer or vehicle.' });
    }
  } else if (!data.customerId || !data.vehicleId) {
    throw Errors.validation({ customerId: 'Choose the customer and the vehicle.' });
  } else if (!data.arrived) {
    throw Errors.validation({ arrived: 'A job can only be opened ahead of arrival from a booking.' });
  }

  if (data.isWalkIn && !(await loadRules(tx, businessId)).allowWalkIns) throw Errors.conflict('Walk-ins are switched off for this workshop (Settings, Bookings).');
  const customerId = booking?.customerId ?? data.customerId!;
  const vehicleId = booking?.vehicleId ?? data.vehicleId!;
  const customer = await tx.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) throw Errors.validation({ customerId: 'Choose a customer of this business.' });
  if (customer.status === 'ARCHIVED') throw Errors.validation({ customerId: 'That customer is archived. Restore them first.' });
  const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId } });
  if (!vehicle) throw Errors.validation({ vehicleId: 'Choose a vehicle of this business.' });
  if (vehicle.archivedAt) throw Errors.validation({ vehicleId: 'That vehicle is archived. Restore it first.' });
  if (vehicle.customerId !== customer.id) throw Errors.validation({ vehicleId: "That vehicle belongs to a different customer. Change the vehicle's owner first." });

  const serviceTypeId = data.serviceTypeId ?? booking?.serviceTypeId ?? undefined;
  const serviceType = serviceTypeId ? await tx.serviceType.findFirst({ where: { id: serviceTypeId, businessId } }) : null;
  if (serviceTypeId && !serviceType) throw Errors.validation({ serviceTypeId: 'Choose a service type of this business.' });

  const technician = data.primaryTechnicianMembershipId ?? booking?.technicianMembershipId ?? undefined;
  if (technician) await assertAssignableTechnician(tx, businessId, technician, 'primaryTechnicianMembershipId');
  const advisor = data.advisorMembershipId ?? ctx.membership.id;
  await assertActiveMember(tx, businessId, advisor, 'advisorMembershipId');

  let locationId = data.locationId ?? booking?.locationId ?? undefined;
  if (locationId) await assertLocation(tx, businessId, locationId);
  else locationId = (await tx.location.findFirst({ where: { businessId, isDefault: true, status: 'ACTIVE' }, select: { id: true } }))?.id;
  const bayId = data.bayId ?? booking?.bayId ?? undefined;
  if (bayId && !(await tx.bay.findFirst({ where: { id: bayId, businessId, status: 'ACTIVE' }, select: { id: true } }))) throw Errors.validation({ bayId: 'Choose a bay of this business.' });

  const arrived = data.arrived;
  assertJobRequirements((await loadConfig(tx, businessId)).jobRequiredFields, {
    complaint: data.complaint ?? booking?.customerNotes, mileageKm: data.mileageKm, technician: technician ?? null, serviceType: serviceType?.id ?? data.serviceLabel ?? booking?.serviceLabel ?? null, arrived,
  });
  const jobNumber = await nextJobNumber(tx, businessId);
  const job = await tx.jobCard.create({
    data: {
      businessId, jobNumber, customerId, vehicleId, bookingId: booking?.id ?? null,
      status: arrived ? 'CHECKED_IN' : 'BOOKED', priority: data.priority,
      serviceTypeId: serviceType?.id ?? null, serviceLabel: serviceType?.name ?? data.serviceLabel ?? booking?.serviceLabel ?? null,
      complaint: data.complaint ?? booking?.customerNotes ?? null, isWalkIn: data.isWalkIn,
      primaryTechnicianMembershipId: technician ?? null, advisorMembershipId: advisor, locationId: locationId ?? null, bayId: bayId ?? null,
      estimatedCompletionAt: data.estimatedCompletionAt ?? booking?.endsAt ?? null, createdById: ctx.user.id,
    },
  });
  await recordAudit(tx, ctx.meta, {
    action: AuditActions.jobCreated, businessId, userId: ctx.user.id, resourceType: 'job', resourceId: job.id, after: job,
    metadata: { bookingId: booking?.id, walkIn: data.isWalkIn },
  });
  await recordActivity(tx, businessId, ctx.user.id, {
    type: 'job.created', summary: `Job ${jobNumber} opened${booking ? ` from booking ${booking.bookingNumber}` : data.isWalkIn ? ' (walk-in)' : ''} for ${vehicleLabel(vehicle)}`,
    customerId, vehicleId, jobId: job.id, bookingId: booking?.id,
  });
  if (technician) {
    await recordActivity(tx, businessId, ctx.user.id, { type: 'job.technician_assigned', summary: 'Technician assigned', customerId, vehicleId, jobId: job.id });
  }
  if (data.mileageKm !== undefined && !arrived) {
    await recordMileageTx(tx, businessId, ctx.user.id, vehicleId, data.mileageKm, 'JOB_CREATED', { jobId: job.id });
    await tx.jobCard.update({ where: { id: job.id }, data: { mileageInKm: data.mileageKm } });
  }
  if (arrived) {
    await recordCheckIn(tx, ctx, job, checkIn);
    await applyWorkflowVehicleStatus(tx, ctx, job, 'CHECKED_IN');
  }
  if (booking && arrived) await markBookingCheckedIn(tx, ctx, booking.id, jobNumber);
  if (arrived) await messageJob(tx, businessId, ctx.user.id, 'JOB_CHECKED_IN', job, `job:${job.id}:JOB_CHECKED_IN`);
  return { job: await tx.jobCard.findFirstOrThrow({ where: { id: job.id, businessId } }), created: true };
}

export async function createJob(ctx: BusinessContext, input: unknown): Promise<OpenJobResult> {
  requirePermission(ctx, 'job.create');
  const data = parseOrThrow(jobCreateSchema, input);
  return withTenant(ctx.business.id, (tx) => openJobTx(ctx, tx, data));
}

/** Check a booking in: opens its job (or returns the one that exists) and marks the booking Checked In. Idempotent. */
export async function checkInBooking(ctx: BusinessContext, bookingId: string, input: unknown = {}): Promise<OpenJobResult> {
  requirePermission(ctx, 'booking.edit');
  requirePermission(ctx, 'job.create');
  const id = parseOrThrow(uuidSchema, bookingId);
  const data = parseOrThrow(jobCreateSchema, { ...(input as object), bookingId: id, arrived: true });
  return withTenant(ctx.business.id, (tx) => openJobTx(ctx, tx, data));
}

// ───────────────────────── status workflow ─────────────────────────

interface StatusOpts {
  reason?: string;
  override?: boolean;
  mileageOutKm?: number;
  completionSummary?: string;
  action?: string;
}

/**
 * Apply a status change that has ALREADY been authorised and validated: update the job, keep the vehicle's workshop
 * status and the booking in step, and leave an audit record plus a timeline event. Always inside the caller's transaction.
 */
export async function applyStatusTx(tx: Tx, ctx: BusinessContext, job: JobRow, to: JobStatus, o: StatusOpts = {}): Promise<JobRow> {
  const businessId = ctx.business.id;
  const from = job.status as JobStatus;
  const now = new Date();
  const patch: Record<string, unknown> = { status: to };
  // A job is never completed with parts still reserved against it, and a cancelled job gives its reservations back.
  if (to === 'COMPLETED') await assertNoPhantomReservations(tx, businessId, job.id, 'The job cannot be completed');
  if (to === 'CANCELLED') await releaseJobReservations(tx, ctx, job);

  if (to === 'ON_HOLD') patch.heldFromStatus = from;
  else patch.heldFromStatus = null;
  if (to === 'CANCELLED') { patch.cancelledAt = now; patch.cancelReason = o.reason ?? null; }
  if (to === 'COMPLETED') {
    patch.completedAt = now; patch.completedById = ctx.user.id;
    if (o.completionSummary !== undefined) patch.completionSummary = o.completionSummary;
    if (o.mileageOutKm !== undefined) {
      await recordMileageTx(tx, businessId, ctx.user.id, job.vehicleId, o.mileageOutKm, 'JOB_COMPLETION', { jobId: job.id });
      patch.mileageOutKm = o.mileageOutKm;
    }
  }
  if (from === 'COMPLETED' && to !== 'COMPLETED') { patch.completedAt = null; patch.completedById = null; }
  if (from === 'CANCELLED' && to !== 'CANCELLED') { patch.cancelledAt = null; patch.cancelReason = null; }

  const after = await tx.jobCard.update({ where: { id: job.id }, data: patch });

  await recordAudit(tx, ctx.meta, {
    action: o.override ? AuditActions.jobStatusOverridden : AuditActions.jobStatusChanged, businessId, userId: ctx.user.id, resourceType: 'job', resourceId: job.id,
    before: { status: from }, after: { status: to }, metadata: { reason: o.reason, action: o.action, jobNumber: job.jobNumber },
  });
  await recordActivity(tx, businessId, ctx.user.id, {
    type: 'job.status_changed', summary: `${JOB_STATUS_LABEL[from]} → ${JOB_STATUS_LABEL[to]}${o.override ? ' (override)' : ''}${o.reason ? ` — ${o.reason}` : ''}`,
    customerId: job.customerId, vehicleId: job.vehicleId, jobId: job.id, data: { from, to, override: !!o.override },
  });
  await applyWorkflowVehicleStatus(tx, ctx, job, to);
  await onJobStatusChanged(tx, businessId, ctx.user.id, from, to, after);

  if (to === 'COMPLETED') {
    await tx.recommendedWork.updateMany({ where: { businessId, jobId: job.id, approvalStatus: 'APPROVED', completedAt: null, archivedAt: null }, data: { completedAt: now } });
    if (job.serviceTypeId) await markServiced(tx, businessId, job.vehicleId, { serviceTypeId: job.serviceTypeId }, now, o.mileageOutKm ?? job.mileageInKm ?? null);
    if (job.bookingId) {
      const b = await tx.booking.findFirst({ where: { id: job.bookingId, businessId } });
      if (b && b.status === 'CHECKED_IN') {
        await tx.booking.update({ where: { id: b.id }, data: { status: 'COMPLETED' } });
        await addBookingEvent(tx, businessId, b.id, ctx.user.id, { type: 'status_changed', fromStatus: 'CHECKED_IN', toStatus: 'COMPLETED', reason: `Job ${job.jobNumber} completed` });
      }
    }
  }
  return after;
}

export const statusChangeSchema = z.object({
  status: z.enum(JOB_STATUSES),
  reason: optionalText(300),
  /** The status the person was looking at. If someone else moved the job meanwhile, the change is refused. */
  expectedStatus: z.enum(JOB_STATUSES).optional(),
  override: z.boolean().default(false),
  mileageOutKm: optionalKm,
  completionSummary: optionalText(2000),
});

export async function changeJobStatus(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.view');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(statusChangeSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId, { allowClosed: true });
    const from = job.status as JobStatus;
    if (d.expectedStatus && d.expectedStatus !== from) {
      throw Errors.conflict(`This job was just changed by someone else (it is now ${JOB_STATUS_LABEL[from].toLowerCase()}). Refresh and try again.`, { currentStatus: from });
    }
    if (d.override) {
      requirePermission(ctx, 'job.override_status');
      if (!d.reason) throw Errors.validation({ reason: 'Explain why the workflow is being overridden.' });
    }
    const decision = decideTransition({ from, to: d.status, heldFrom: job.heldFromStatus as JobStatus | null, override: d.override });
    if (!decision.allowed) throw Errors.conflict(decision.reason ?? 'That status change is not allowed.', { from, to: d.status });
    // A step the business has switched off cannot be chosen afresh. Jobs already sitting in it can still leave it (resume), so history is never stranded.
    if (decision.kind !== 'resume' && (await loadConfig(tx, ctx.business.id)).retiredJobStatuses.includes(d.status)) {
      throw Errors.conflict(`${JOB_STATUS_LABEL[d.status]} is switched off for this workshop (Settings, Jobs).`);
    }

    // Who may make which move.
    if (!d.override) {
      if (d.status === 'CANCELLED') requirePermission(ctx, 'job.cancel');
      else if (d.status === 'COMPLETED') requirePermission(ctx, 'job.complete');
      else requirePermission(ctx, 'job.change_status');
    } else if (d.status === 'COMPLETED') requirePermission(ctx, 'job.complete');
    if ((d.status === 'CANCELLED' || d.status === 'ON_HOLD') && !d.reason) throw Errors.validation({ reason: `Enter a reason for ${d.status === 'CANCELLED' ? 'cancelling' : 'holding'} this job.` });

    if (!d.override) {
      const live = { businessId: ctx.business.id, jobId, archivedAt: null };
      if (d.status === 'AWAITING_APPROVAL' && (await tx.recommendedWork.count({ where: live })) === 0) {
        throw Errors.conflict('Add at least one piece of recommended work before asking for approval.');
      }
      if (d.status === 'APPROVED' && decision.kind === 'forward') {
        const pending = await tx.recommendedWork.count({ where: { ...live, approvalStatus: 'PENDING' } });
        const approved = await tx.recommendedWork.count({ where: { ...live, approvalStatus: 'APPROVED' } });
        if (pending > 0) throw Errors.conflict(`${pending} recommended item${pending === 1 ? ' is' : 's are'} still waiting for a decision.`);
        if (approved === 0) throw Errors.conflict('Every recommended item was declined. Cancel or hold the job instead of approving it.');
      }
    }
    const after = await applyStatusTx(tx, ctx, job, d.status, {
      reason: d.reason, override: d.override, mileageOutKm: d.mileageOutKm, completionSummary: d.completionSummary,
    });
    return after;
  });
}

// ───────────────────────── quality check ─────────────────────────

export const qualityCheckSchema = z.object({
  passed: z.boolean(),
  /** key → true/false; test_drive may also be "na" when no test drive was required. */
  checklist: z.record(z.string(), z.union([z.boolean(), z.literal('na')])),
  reason: optionalText(500),
  notes: optionalText(2000),
});

/** The Quality Check result. A pass needs the whole checklist done and moves the job to Ready for Collection; a fail needs a reason and sends it back to In Progress. */
export async function recordQualityCheck(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.quality_check');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(qualityCheckSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    if (job.status !== 'QUALITY_CHECK') throw Errors.conflict('The job must be in Quality Check to record a result.');

    const known = new Set<string>(QUALITY_CHECKLIST.map((c) => c.key));
    for (const k of Object.keys(d.checklist)) if (!known.has(k)) throw Errors.validation({ checklist: `Unknown checklist item "${k}".` });
    if (Object.entries(d.checklist).some(([k, v]) => v === 'na' && k !== 'test_drive')) throw Errors.validation({ checklist: 'Only the test drive can be marked not required.' });
    const items = QUALITY_CHECKLIST.map((c) => ({ key: c.key, label: c.label, result: d.checklist[c.key] === 'na' ? 'na' : d.checklist[c.key] === true ? 'done' : 'not_done' }));

    if (d.passed) {
      await assertNoPhantomReservations(tx, ctx.business.id, jobId, 'The quality check cannot pass');
      const missing = items.filter((i) => i.result === 'not_done');
      if (missing.length > 0) throw Errors.validation({ checklist: `Complete every item before passing: ${missing.map((m) => m.label).join(', ')}.` });
    } else if (!d.reason) {
      throw Errors.validation({ reason: 'Explain why the job failed its quality check.' });
    }

    await tx.jobQualityCheck.create({
      data: { businessId: ctx.business.id, jobId, passed: d.passed, checklist: items, reason: d.reason ?? null, notes: d.notes ?? null, checkedById: ctx.user.id },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.qualityCheckRecorded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId,
      metadata: { passed: d.passed, reason: d.reason, jobNumber: job.jobNumber },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'job.quality_check', summary: d.passed ? 'Quality check passed' : `Quality check failed — ${d.reason}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
    });
    return applyStatusTx(tx, ctx, job, d.passed ? 'READY_FOR_COLLECTION' : 'IN_PROGRESS', { reason: d.passed ? 'Quality check passed' : d.reason, action: 'quality_check' });
  });
}

// ───────────────────────── editing ─────────────────────────

export async function updateJob(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(jobUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await loadJobForWrite(tx, ctx, jobId);
    const patch: Record<string, unknown> = {};
    if (d.complaint !== undefined) patch.complaint = d.complaint;
    if (d.serviceTypeId) {
      const t = await tx.serviceType.findFirst({ where: { id: d.serviceTypeId, businessId: ctx.business.id } });
      if (!t) throw Errors.validation({ serviceTypeId: 'Choose a service type of this business.' });
      patch.serviceTypeId = t.id; patch.serviceLabel = t.name;
    } else if (d.serviceLabel !== undefined) { patch.serviceLabel = d.serviceLabel; patch.serviceTypeId = null; }
    if (d.priority !== undefined) patch.priority = d.priority;
    if (d.estimatedCompletionAt !== undefined) patch.estimatedCompletionAt = d.estimatedCompletionAt;
    if (d.locationId !== undefined) { if (d.locationId) await assertLocation(tx, ctx.business.id, d.locationId); patch.locationId = d.locationId; }
    if (d.bayId !== undefined) {
      if (d.bayId && !(await tx.bay.findFirst({ where: { id: d.bayId, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } }))) throw Errors.validation({ bayId: 'Choose a bay of this business.' });
      patch.bayId = d.bayId;
    }
    if (d.advisorMembershipId !== undefined) { if (d.advisorMembershipId) await assertActiveMember(tx, ctx.business.id, d.advisorMembershipId, 'advisorMembershipId'); patch.advisorMembershipId = d.advisorMembershipId; }

    const after = await tx.jobCard.update({ where: { id: jobId }, data: patch });
    if (d.priority !== undefined && d.priority !== before.priority) {
      await recordAudit(tx, ctx.meta, {
        action: AuditActions.jobPriorityChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId,
        before: { priority: before.priority }, after: { priority: after.priority },
      });
      await recordActivity(tx, ctx.business.id, ctx.user.id, {
        type: 'job.priority_changed', summary: `Priority ${before.priority.toLowerCase()} → ${after.priority.toLowerCase()}`, customerId: before.customerId, vehicleId: before.vehicleId, jobId,
      });
    }
    const { priority: _p, ...rest } = d;
    void _p;
    if (Object.keys(rest).some((k) => (rest as Record<string, unknown>)[k] !== undefined)) {
      await recordAudit(tx, ctx.meta, { action: AuditActions.jobUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, before, after });
      await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.updated', summary: 'Job details updated', customerId: before.customerId, vehicleId: before.vehicleId, jobId });
    }
    return after;
  });
}

export const assignSchema = z.object({
  primaryTechnicianMembershipId: nullableUuid,
  additionalTechnicianMembershipIds: z.array(uuidSchema).max(10).optional(),
});

export async function assignTechnicians(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.assign');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(assignSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await loadJobForWrite(tx, ctx, jobId);
    const primary = d.primaryTechnicianMembershipId !== undefined ? d.primaryTechnicianMembershipId : before.primaryTechnicianMembershipId;
    const extras = [...new Set(d.additionalTechnicianMembershipIds ?? [])].filter((m) => m !== primary);
    const previousExtras = (await tx.jobTechnician.findMany({ where: { businessId: ctx.business.id, jobId } })).map((r) => r.membershipId);
    // Someone already on the job may stay on it even if they were deactivated since; only NEW people must be assignable.
    const already = new Set([before.primaryTechnicianMembershipId, ...previousExtras].filter((m): m is string => !!m));
    for (const m of [...(primary ? [primary] : []), ...extras]) {
      if (already.has(m)) await assertActiveMember(tx, ctx.business.id, m, 'technician');
      else await assertAssignableTechnician(tx, ctx.business.id, m, 'technician');
    }
    if (d.additionalTechnicianMembershipIds !== undefined) {
      await tx.jobTechnician.deleteMany({ where: { businessId: ctx.business.id, jobId } });
      if (extras.length) await tx.jobTechnician.createMany({ data: extras.map((membershipId) => ({ businessId: ctx.business.id, jobId, membershipId, addedById: ctx.user.id })) });
    }
    const after = await tx.jobCard.update({ where: { id: jobId }, data: { primaryTechnicianMembershipId: primary } });
    await recordAssignmentChanges(tx, ctx, before, { primaryBefore: before.primaryTechnicianMembershipId, primaryAfter: primary, extrasBefore: previousExtras, extrasAfter: d.additionalTechnicianMembershipIds !== undefined ? extras : previousExtras });
    const names = await memberNames(tx, ctx.business.id, [before.primaryTechnicianMembershipId, primary, ...previousExtras, ...extras]);
    const nm = (m: string | null) => (m ? (names.get(m) ?? 'Unknown') : 'nobody');
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.jobTechnicianAssigned, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId,
      before: { primary: before.primaryTechnicianMembershipId, additional: previousExtras }, after: { primary, additional: d.additionalTechnicianMembershipIds !== undefined ? extras : previousExtras },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'job.technician_assigned',
      summary: `Technician: ${nm(before.primaryTechnicianMembershipId)} → ${nm(primary)}${d.additionalTechnicianMembershipIds !== undefined ? `; also working: ${extras.map((e) => nm(e)).join(', ') || 'nobody'}` : ''}`,
      customerId: before.customerId, vehicleId: before.vehicleId, jobId,
    });
    return after;
  });
}

export const checkInUpdateSchema = z.object({
  mileageKm: optionalKm,
  ...checkInFields,
  signatureFileId: optionalUuid,
});

/** Add to / correct the check-in record of an arrived job (technicians do this from the job). */
export async function updateCheckIn(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(checkInUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId);
    const existing = await tx.jobCheckIn.findFirst({ where: { jobId, businessId: ctx.business.id } });
    if (!existing) throw Errors.conflict('This job has not been checked in yet.');
    if (d.signatureFileId) {
      const photo = await tx.jobPhoto.findFirst({ where: { businessId: ctx.business.id, jobId, fileId: d.signatureFileId, category: 'SIGNATURE', archivedAt: null } });
      if (!photo) throw Errors.validation({ signatureFileId: 'Use a signature captured on this job.' });
    }
    if (d.mileageKm !== undefined && d.mileageKm !== existing.mileageKm) {
      await recordMileageTx(tx, ctx.business.id, ctx.user.id, job.vehicleId, d.mileageKm, 'CHECK_IN', { jobId });
      await tx.jobCard.update({ where: { id: jobId }, data: { mileageInKm: d.mileageKm } });
    }
    const signed = d.signatureName || d.signatureFileId;
    const after = await tx.jobCheckIn.update({
      where: { id: existing.id },
      data: {
        ...(d.mileageKm !== undefined ? { mileageKm: d.mileageKm } : {}),
        ...(d.fuelLevel !== undefined ? { fuelLevel: d.fuelLevel } : {}),
        ...(d.existingDamage !== undefined ? { existingDamage: d.existingDamage } : {}),
        ...(d.vehicleCondition !== undefined ? { vehicleCondition: d.vehicleCondition } : {}),
        ...(d.keysAccessories !== undefined ? { keysAccessories: d.keysAccessories } : {}),
        ...(d.checkInNotes !== undefined ? { notes: d.checkInNotes } : {}),
        ...(d.signatureName !== undefined ? { signatureName: d.signatureName } : {}),
        ...(d.signatureFileId !== undefined ? { signatureFileId: d.signatureFileId } : {}),
        ...(signed && !existing.signedAt ? { signedAt: new Date() } : {}),
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.jobUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId, before: existing, after, metadata: { part: 'check_in' } });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'job.updated', summary: 'Check-in details updated', customerId: job.customerId, vehicleId: job.vehicleId, jobId });
    return after;
  });
}

// ───────────────────────── notes ─────────────────────────

export const noteSchema = z.object({ body: z.string().trim().min(1, 'Write a note').max(4000), visibility: z.enum(['INTERNAL', 'CUSTOMER']).default('INTERNAL') });

export async function addJobNote(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(noteSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId, { allowClosed: true });
    const note = await tx.jobNote.create({ data: { businessId: ctx.business.id, jobId, body: d.body, visibility: d.visibility, authorId: ctx.user.id } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.jobNoteAdded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId,
      metadata: { noteId: note.id, visibility: note.visibility },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'job.note_added', summary: d.visibility === 'CUSTOMER' ? 'Customer-visible note added' : 'Internal note added',
      customerId: job.customerId, vehicleId: job.vehicleId, jobId, visibility: d.visibility,
    });
    return note;
  });
}

/** Moving a note between internal and customer-visible is an important change, so it is audited with who and when. */
export async function setJobNoteVisibility(ctx: BusinessContext, id: string, noteId: string, visibility: unknown) {
  requirePermission(ctx, 'job.edit');
  const jobId = parseOrThrow(uuidSchema, id);
  const nId = parseOrThrow(uuidSchema, noteId);
  const v = parseOrThrow(z.enum(['INTERNAL', 'CUSTOMER']), visibility);
  return withTenant(ctx.business.id, async (tx) => {
    const job = await loadJobForWrite(tx, ctx, jobId, { allowClosed: true });
    const note = await tx.jobNote.findFirst({ where: { id: nId, jobId, businessId: ctx.business.id, archivedAt: null } });
    if (!note) throw Errors.notFound('Note');
    if (note.visibility === v) return note;
    const after = await tx.jobNote.update({ where: { id: nId }, data: { visibility: v } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.jobNoteVisibilityChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'job', resourceId: jobId,
      before: { visibility: note.visibility }, after: { visibility: v }, metadata: { noteId: nId },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'job.note_visibility_changed', summary: `A note was made ${v === 'CUSTOMER' ? 'visible to the customer' : 'internal'}`, customerId: job.customerId, vehicleId: job.vehicleId, jobId,
    });
    return after;
  });
}

// ───────────────────────── reading ─────────────────────────

export const jobFilterSchema = z.object({
  status: z.union([z.enum(JOB_STATUSES), z.enum(['open', 'closed'])]).optional(),
  technicianId: uuidSchema.optional(),
  mine: z.enum(['true']).optional(),
  priority: priority.optional(),
  from: bookingFilterSchema.shape.from,
  to: bookingFilterSchema.shape.to,
  customerId: uuidSchema.optional(),
  vehicleId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  serviceTypeId: uuidSchema.optional(),
  q: z.string().trim().max(100).optional(),
});

export const jobListSchema = paginationSchema.merge(jobFilterSchema).extend({
  sort: z.enum(['openedAt', 'jobNumber', 'priority']).default('openedAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const PRIORITY_RANK = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as const;

export const jobInclude = {
  customer: { select: { id: true, name: true, customerNumber: true, mobile: true } },
  vehicle: { select: { id: true, registration: true, make: true, model: true, colour: true, mileageKm: true } },
} as const;

async function filterWhere(tx: Tx, ctx: BusinessContext, f: z.output<typeof jobFilterSchema>) {
  const scope = await visibleLocationIds(tx, ctx);
  const tz = ctx.business.timezone;
  const techIds: string[] = [];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.business_id = ${ctx.business.id}::uuid AND u.name ILIKE ${like} ESCAPE '\\'`;
    techIds.push(...rows.map((r) => r.id));
  }
  return {
    businessId: ctx.business.id,
    ...locationWhere(scope),
    ...(f.status === 'open' ? { status: { notIn: ['COMPLETED', 'CANCELLED'] as JobStatus[] } } : f.status === 'closed' ? { status: { in: ['COMPLETED', 'CANCELLED'] as JobStatus[] } } : f.status ? { status: f.status } : {}),
    ...(f.mine ? { OR: [{ primaryTechnicianMembershipId: ctx.membership.id }, { technicians: { some: { membershipId: ctx.membership.id } } }] } : {}),
    ...(f.technicianId ? { OR: [{ primaryTechnicianMembershipId: f.technicianId }, { technicians: { some: { membershipId: f.technicianId } } }] } : {}),
    ...(f.priority ? { priority: f.priority } : {}),
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
    ...(f.locationId ? { locationId: f.locationId } : {}),
    ...(f.serviceTypeId ? { serviceTypeId: f.serviceTypeId } : {}),
    ...(f.from || f.to ? { openedAt: { ...(f.from ? { gte: dayRange(f.from, tz).start } : {}), ...(f.to ? { lt: dayRange(f.to, tz).end } : {}) } } : {}),
    ...(f.q
      ? {
          AND: f.q.split(/\s+/).filter(Boolean).slice(0, 5).map((w) => {
            const norm = w.toUpperCase().replace(/[^A-Z0-9]/g, '') || escapeLike(w);
            return {
              OR: [
                { jobNumber: { contains: w, mode: 'insensitive' as const } },
                { customer: { name: { contains: w, mode: 'insensitive' as const } } },
                { vehicle: { registrationNorm: { contains: norm, mode: 'insensitive' as const } } },
                { vehicle: { vin: { contains: norm, mode: 'insensitive' as const } } },
                { serviceLabel: { contains: w, mode: 'insensitive' as const } },
                ...(techIds.length ? [{ primaryTechnicianMembershipId: { in: techIds } }] : []),
              ],
            };
          }),
        }
      : {}),
  };
}

export async function decorateJobs<T extends JobRow>(tx: Tx, businessId: string, rows: T[]) {
  const names = await memberNames(tx, businessId, rows.map((r) => r.primaryTechnicianMembershipId));
  return rows.map((r) => ({ ...r, technicianName: r.primaryTechnicianMembershipId ? (names.get(r.primaryTechnicianMembershipId) ?? null) : null }));
}

export async function listJobs(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'job.view');
  const q = parseOrThrow(jobListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const where = await filterWhere(tx, ctx, q);
    const orderBy = q.sort === 'priority' ? undefined : [{ [q.sort]: q.dir }, { id: 'asc' as const }];
    const skip = (q.page - 1) * q.pageSize;
    const total = await tx.jobCard.count({ where });
    let rows;
    if (q.sort === 'priority') {
      // priority is an enum stored in a fixed order; rank it explicitly so URGENT sorts first.
      const all = await tx.jobCard.findMany({ where, include: jobInclude, orderBy: [{ openedAt: 'desc' }, { id: 'asc' }], take: 2000 });
      all.sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) * (q.dir === 'asc' ? 1 : -1) || b.openedAt.getTime() - a.openedAt.getTime());
      rows = all.slice(skip, skip + q.pageSize);
    } else {
      rows = await tx.jobCard.findMany({ where, include: jobInclude, orderBy, skip, take: q.pageSize });
    }
    return { items: await decorateJobs(tx, ctx.business.id, rows), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

/** The technician's own queue: open jobs they are the primary or an additional technician on, most urgent first. */
export async function listMyJobs(ctx: BusinessContext) {
  requirePermission(ctx, 'job.view');
  return withTenant(ctx.business.id, async (tx) => {
    const where = await filterWhere(tx, ctx, { mine: 'true', status: 'open' });
    const rows = await tx.jobCard.findMany({ where: { ...where, status: { notIn: ['COMPLETED', 'CANCELLED', 'BOOKED'] } }, include: jobInclude, orderBy: [{ openedAt: 'asc' }], take: 100 });
    rows.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    return decorateJobs(tx, ctx.business.id, rows);
  });
}

/**
 * The whole Job Card in as few queries as possible (it is the screen opened most). Part costs, prices and labour
 * rates are only returned to people with job.view_pricing; internal fields are staff-only by construction because
 * this endpoint is staff-only (the customer-facing views live in jobcards/reports.ts).
 */
export async function getJobCard(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.view');
  const jobId = parseOrThrow(uuidSchema, id);
  const pricing = can(ctx, 'job.view_pricing');
  return withTenant(ctx.business.id, async (tx) => {
    const base = await loadJob(tx, ctx, jobId);
    const businessId = ctx.business.id;
    const live = { businessId, jobId, archivedAt: null };
    const [job, booking, checkIn, extraTechs, notes, photos, inspection, diagnoses, work, parts, labour, quality] = await seq([
      tx.jobCard.findFirstOrThrow({ where: { id: jobId, businessId }, include: { customer: true, vehicle: true } }),
      base.bookingId ? tx.booking.findFirst({ where: { id: base.bookingId, businessId }, select: { id: true, bookingNumber: true, startsAt: true, status: true } }) : null,
      tx.jobCheckIn.findFirst({ where: { jobId, businessId } }),
      tx.jobTechnician.findMany({ where: { jobId, businessId } }),
      tx.jobNote.findMany({ where: live, orderBy: { createdAt: 'desc' } }),
      tx.jobPhoto.findMany({ where: live, orderBy: { createdAt: 'desc' } }),
      tx.inspection.findFirst({ where: { jobId, businessId }, include: { items: { orderBy: { sortOrder: 'asc' } } } }),
      tx.diagnosis.findMany({ where: live, orderBy: { recordedAt: 'desc' } }),
      tx.recommendedWork.findMany({ where: live, orderBy: { createdAt: 'asc' } }),
      tx.jobPart.findMany({ where: live, orderBy: { createdAt: 'asc' } }),
      tx.jobLabour.findMany({ where: live, orderBy: { createdAt: 'asc' } }),
      tx.jobQualityCheck.findMany({ where: { businessId, jobId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const assigned = can(ctx, 'job.assign') || can(ctx, 'job.override_status')
      ? true
      : (await tx.jobCard.count({ where: { id: jobId, businessId, OR: [{ primaryTechnicianMembershipId: ctx.membership.id }, { technicians: { some: { membershipId: ctx.membership.id } } }] } })) > 0;
    const names = await memberNames(tx, businessId, [
      job.primaryTechnicianMembershipId, job.advisorMembershipId, ...extraTechs.map((t) => t.membershipId), inspection?.technicianMembershipId,
      ...diagnoses.map((d) => d.technicianMembershipId), ...labour.map((l) => l.technicianMembershipId),
    ]);
    const nm = (m: string | null | undefined) => (m ? (names.get(m) ?? null) : null);
    const status = job.status as JobStatus;
    const total = pricing
      ? {
          partsCents: parts.filter((p) => p.status !== 'RETURNED').reduce((s, p) => s + (p.sellPriceCents ?? 0) * p.quantity, 0),
          labourCents: labour.reduce((s, l) => s + (l.totalCents ?? 0), 0),
          recommendedCents: work.filter((w) => w.approvalStatus !== 'DECLINED').reduce((s, w) => s + (w.estimatedLabourCents ?? 0) + (w.estimatedPartsCents ?? 0), 0),
        }
      : null;
    const retiredStatuses = (await loadConfig(tx, ctx.business.id)).retiredJobStatuses as string[];
    return {
      job: { ...job, technicianName: nm(job.primaryTechnicianMembershipId), advisorName: nm(job.advisorMembershipId) },
      booking, checkIn,
      additionalTechnicians: extraTechs.map((t) => ({ membershipId: t.membershipId, name: nm(t.membershipId) })),
      notes, photos,
      inspection: inspection ? { ...inspection, technicianName: nm(inspection.technicianMembershipId) } : null,
      diagnoses: diagnoses.map((d) => ({ ...d, technicianName: nm(d.technicianMembershipId) })),
      recommendedWork: work.map((w) => (pricing ? w : { ...w, estimatedLabourCents: null, estimatedPartsCents: null })),
      parts: await presentJobParts(tx, ctx, parts),
      labour: labour.map((l) => ({ ...(pricing ? l : { ...l, rateCentsPerHour: null, totalCents: null }), technicianName: nm(l.technicianMembershipId) })),
      qualityChecks: quality, total,
      // A step the business switched off is not offered (a job already in it can still resume).
      transitions: assigned ? nextStatuses(status, job.heldFromStatus as JobStatus | null).filter((t) => t.kind === 'resume' || !retiredStatuses.includes(t.to)) : [],
      canWork: assigned && isOpen(status),
    };
  });
}

export { JOB_STATUSES, JOB_STATUS_LABEL };
