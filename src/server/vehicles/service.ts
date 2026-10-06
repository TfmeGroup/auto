import { z } from 'zod';
import { Prisma, withTenant, type Tx, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { escapeLike, optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { requirePermission } from '@/server/permissions/authorize';
import { loadConfig } from '@/server/settings/config';
import { assertVehicleRules } from '@/server/settings/config-service';
import type { BusinessContext } from '@/server/context';

/**
 * Vehicles belong to a business and to one owning customer (a separate record; one customer can own many
 * vehicles). Registration and VIN are unique within a business among live vehicles, never across
 * businesses. Odometer readings are an append-only history: a lower reading is refused unless an
 * authorised person records it as a correction with a reason.
 */

export const normalizeRegistration = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

const optionalInt = (min: number, max: number, msg: string) =>
  z.union([z.literal(''), z.coerce.number().int(msg).min(min, msg).max(max, msg)]).optional().transform((v) => (v === '' || v === undefined ? undefined : v));

const optionalEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.literal(''), z.enum(values)]).optional().transform((v): T[number] | undefined => (v ? (v as T[number]) : undefined));

const registrationField = optionalText(20).refine((v) => v === undefined || normalizeRegistration(v).length >= 2, 'Enter a valid registration number');
const vinField = optionalText(30)
  .transform((v) => (v ? v.toUpperCase().replace(/\s+/g, '') : undefined))
  .refine((v) => v === undefined || /^[A-HJ-NPR-Z0-9]{11,17}$/.test(v), 'A VIN is 11 to 17 letters and digits (no I, O or Q)');

export const VEHICLE_STATUSES = ['ACTIVE', 'AWAITING_SERVICE', 'IN_WORKSHOP', 'AWAITING_PARTS', 'REPAIR_REQUIRED', 'INACTIVE'] as const;
const currentYear = () => new Date().getUTCFullYear();

const vehicleFields = {
  customerId: uuidSchema,
  registration: registrationField,
  vin: vinField,
  make: optionalText(60),
  model: optionalText(60),
  year: optionalInt(1900, currentYear() + 1, 'Enter a valid year'),
  variant: optionalText(80),
  colour: optionalText(40),
  engine: optionalText(80),
  engineSizeCc: optionalInt(50, 20000, 'Engine size is in cc, e.g. 1998'),
  fuelType: optionalEnum(['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'LPG', 'OTHER']),
  transmission: optionalEnum(['MANUAL', 'AUTOMATIC', 'CVT', 'DCT', 'OTHER']),
  driveType: optionalEnum(['FWD', 'RWD', 'AWD', 'FOUR_BY_FOUR', 'OTHER']),
  notes: optionalText(2000),
};

export const vehicleCreateSchema = z
  .object({ ...vehicleFields, mileageKm: optionalInt(0, 5_000_000, 'Enter the odometer reading in km') })
  .superRefine((v, ctx) => {
    if (!v.registration && !v.vin && !(v.make && v.model)) {
      ctx.addIssue({ code: 'custom', path: ['registration'], message: 'Enter a registration, a VIN, or the make and model' });
    }
  });
export const vehicleUpdateSchema = z.object(vehicleFields).partial();

export const vehicleListSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(VEHICLE_STATUSES).optional(),
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  customerId: uuidSchema.optional(),
  archived: z.enum(['true']).optional(),
  sort: z.enum(['createdAt', 'registration', 'make']).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
const SORT_SQL = { createdAt: 'v.created_at', registration: 'v.registration_norm', make: 'lower(v.make)' } as const;

export interface VehicleQuery {
  q?: string;
  status?: (typeof VEHICLE_STATUSES)[number];
  make?: string;
  model?: string;
  customerId?: string;
  archived?: boolean;
  limit: number;
  offset?: number;
  order?: string;
}

/** Vehicle ids matching a query. Every word must match registration, VIN, make, model, variant or the owner. */
export async function matchVehicleIds(tx: Tx, businessId: string, opts: VehicleQuery): Promise<{ ids: string[]; total: number }> {
  const params: unknown[] = [businessId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ['v.business_id = $1::uuid', opts.archived ? 'v.archived_at IS NOT NULL' : 'v.archived_at IS NULL'];
  if (opts.status) where.push(`v.status = ${p(opts.status)}::vehicle_status`);
  if (opts.customerId) where.push(`v.customer_id = ${p(opts.customerId)}::uuid`);
  if (opts.make) where.push(`v.make ILIKE ${p(escapeLike(opts.make))} ESCAPE '\\'`);
  if (opts.model) where.push(`v.model ILIKE ${p(escapeLike(opts.model))} ESCAPE '\\'`);
  for (const word of (opts.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6)) {
    const like = p(`%${escapeLike(word)}%`);
    const regLike = p(`%${escapeLike(normalizeRegistration(word) || word)}%`);
    where.push(
      `(v.registration_norm ILIKE ${regLike} ESCAPE '\\' OR v.vin ILIKE ${like} ESCAPE '\\' OR v.make ILIKE ${like} ESCAPE '\\'
        OR v.model ILIKE ${like} ESCAPE '\\' OR v.variant ILIKE ${like} ESCAPE '\\'
        OR c.name ILIKE ${like} ESCAPE '\\' OR c.customer_number ILIKE ${like} ESCAPE '\\')`,
    );
  }
  const limit = p(opts.limit);
  const offset = p(opts.offset ?? 0);
  const rows = await tx.$queryRawUnsafe<{ id: string; total: bigint }[]>(
    `SELECT v.id, count(*) OVER () AS total
       FROM vehicles v JOIN customers c ON c.id = v.customer_id AND c.business_id = v.business_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${opts.order ?? 'v.created_at DESC'}, v.id LIMIT ${limit} OFFSET ${offset}`,
    ...params,
  );
  return { ids: rows.map((r) => r.id), total: Number(rows[0]?.total ?? 0) };
}

const withOwner = { customer: { select: { id: true, name: true, customerNumber: true, mobile: true } } } as const;

export async function listVehicles(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'vehicle.view');
  const q = parseOrThrow(vehicleListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const order = `${SORT_SQL[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'}`;
    const { ids, total } = await matchVehicleIds(tx, ctx.business.id, {
      q: q.q, status: q.status, make: q.make, model: q.model, customerId: q.customerId, archived: !!q.archived,
      limit: q.pageSize, offset: (q.page - 1) * q.pageSize, order,
    });
    const rows = await tx.vehicle.findMany({ where: { id: { in: ids }, businessId: ctx.business.id }, include: withOwner });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: ids.map((id) => byId.get(id)).filter((r) => !!r), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

export async function getVehicle(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'vehicle.view');
  const vehicleId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id }, include: { ...withOwner, contacts: { orderBy: { createdAt: 'asc' } } } });
    if (!v) throw Errors.notFound('Vehicle');
    return v;
  });
}

async function assertCustomer(tx: Tx, businessId: string, customerId: string) {
  const c = await tx.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true, status: true } });
  if (!c) throw Errors.validation({ customerId: 'Choose a customer of this business.' });
  if (c.status === 'ARCHIVED') throw Errors.validation({ customerId: 'That customer is archived. Restore them first.' });
}

async function assertIdentifiersFree(tx: Tx, businessId: string, norm: string | null | undefined, vin: string | null | undefined, exceptId?: string) {
  if (norm) {
    const dup = await tx.vehicle.findFirst({ where: { businessId, registrationNorm: norm, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (dup) throw Errors.validation({ registration: 'A vehicle with this registration already exists in your business.' });
  }
  if (vin) {
    const dup = await tx.vehicle.findFirst({ where: { businessId, vin, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (dup) throw Errors.validation({ vin: 'A vehicle with this VIN already exists in your business.' });
  }
}

/** A concurrent insert that slips past the pre-check is stopped by the unique index; report it the same way. */
function mapUnique(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw Errors.validation({ registration: 'A vehicle with this registration or VIN already exists in your business.' });
  }
  throw err;
}

export async function createVehicle(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'vehicle.create');
  const { mileageKm, ...data } = parseOrThrow(vehicleCreateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    assertVehicleRules(await loadConfig(tx, ctx.business.id), { ...data, mileageKm }, null, { creating: true });
    await assertCustomer(tx, ctx.business.id, data.customerId);
    const norm = data.registration ? normalizeRegistration(data.registration) : null;
    await assertIdentifiersFree(tx, ctx.business.id, norm, data.vin);
    const vehicle = await tx.vehicle
      .create({
        data: {
          ...data,
          registration: data.registration?.toUpperCase() ?? null,
          registrationNorm: norm,
          mileageKm: mileageKm ?? null,
          businessId: ctx.business.id,
          createdById: ctx.user.id,
        },
      })
      .catch(mapUnique);
    if (mileageKm !== undefined) {
      await tx.vehicleMileage.create({
        data: { businessId: ctx.business.id, vehicleId: vehicle.id, mileageKm, source: 'CREATED', recordedById: ctx.user.id },
      });
    }
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleCreated, businessId: ctx.business.id, userId: ctx.user.id,
      resourceType: 'vehicle', resourceId: vehicle.id, after: vehicle,
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'vehicle.added', summary: `Vehicle ${vehicleLabel(vehicle)} added`, customerId: vehicle.customerId, vehicleId: vehicle.id,
    });
    return vehicle;
  });
}

export const vehicleLabel = (v: { registration?: string | null; make?: string | null; model?: string | null }) =>
  [v.registration, [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Vehicle';

export async function updateVehicle(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'vehicle.edit');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(vehicleUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM vehicles WHERE id = ${vehicleId}::uuid AND business_id = ${ctx.business.id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw Errors.notFound('Vehicle');
    const before = await tx.vehicle.findFirstOrThrow({ where: { id: vehicleId, businessId: ctx.business.id } });
    if (before.archivedAt) throw Errors.conflict('Restore this vehicle before editing it.');
    assertVehicleRules(await loadConfig(tx, ctx.business.id), data, before as unknown as Record<string, unknown>, { creating: false });

    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Prisma.VehicleUncheckedUpdateInput;
    if (data.customerId && data.customerId !== before.customerId) await assertCustomer(tx, ctx.business.id, data.customerId);
    if (data.registration !== undefined) {
      patch.registration = data.registration.toUpperCase();
      patch.registrationNorm = normalizeRegistration(data.registration);
    }
    await assertIdentifiersFree(tx, ctx.business.id, patch.registrationNorm as string | undefined, data.vin, vehicleId);

    const after = await tx.vehicle.update({ where: { id: vehicleId }, data: patch }).catch(mapUnique);
    const ownerChanged = after.customerId !== before.customerId;
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleUpdated, businessId: ctx.business.id, userId: ctx.user.id,
      resourceType: 'vehicle', resourceId: vehicleId, before, after,
      metadata: ownerChanged ? { ownerChangedFrom: before.customerId, ownerChangedTo: after.customerId } : undefined,
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: ownerChanged ? 'vehicle.owner_changed' : 'vehicle.updated',
      summary: ownerChanged ? 'Vehicle moved to a different owner' : 'Vehicle details updated',
      customerId: after.customerId, vehicleId,
    });
    if (ownerChanged) {
      await recordActivity(tx, ctx.business.id, ctx.user.id, {
        type: 'vehicle.owner_changed', summary: `Vehicle ${vehicleLabel(after)} moved to another owner`, customerId: before.customerId, vehicleId,
      });
    }
    return after;
  });
}

/** Archive / restore. A vehicle with an open job cannot be archived; history is always kept. */
export async function setVehicleArchived(ctx: BusinessContext, id: string, archived: boolean) {
  requirePermission(ctx, 'vehicle.archive');
  const vehicleId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Vehicle');
    if (archived) {
      const open = await tx.jobCard.count({ where: { businessId: ctx.business.id, vehicleId, status: { notIn: ['COMPLETED', 'CANCELLED'] } } });
      if (open > 0) throw Errors.conflict('This vehicle has an open job. Finish or cancel it before archiving.');
    } else {
      await assertIdentifiersFree(tx, ctx.business.id, before.registrationNorm, before.vin, vehicleId);
    }
    const after = await tx.vehicle.update({ where: { id: vehicleId }, data: { archivedAt: archived ? new Date() : null } }).catch(mapUnique);
    await recordAudit(tx, ctx.meta, {
      action: archived ? AuditActions.vehicleArchived : AuditActions.vehicleRestored, businessId: ctx.business.id, userId: ctx.user.id,
      resourceType: 'vehicle', resourceId: vehicleId,
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'vehicle.updated', summary: archived ? 'Vehicle archived' : 'Vehicle restored', customerId: before.customerId, vehicleId,
    });
    return after;
  });
}

// ───────────────────────── status ─────────────────────────

export async function setVehicleStatus(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'vehicle.edit');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const { status, reason } = parseOrThrow(z.object({ status: z.enum(VEHICLE_STATUSES), reason: optionalText(300) }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Vehicle');
    if (before.status === status) return before;
    const after = await tx.vehicle.update({ where: { id: vehicleId }, data: { status } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleStatusChanged, businessId: ctx.business.id, userId: ctx.user.id,
      resourceType: 'vehicle', resourceId: vehicleId, before: { status: before.status }, after: { status }, metadata: { source: 'manual', reason },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'vehicle.status_changed', summary: `Status set to ${labelOf(status)}${reason ? ` — ${reason}` : ''}`, customerId: before.customerId, vehicleId,
    });
    return after;
  });
}

const labelOf = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/**
 * Workflow rule: how a job's status moves its vehicle's status. Called by the job service inside the same
 * transaction. A vehicle an operator has marked INACTIVE is never changed by a job, and every change records
 * the job and the reason, so nothing is overwritten silently.
 */
const JOB_TO_VEHICLE: Record<string, (typeof VEHICLE_STATUSES)[number] | 'ACTIVE_IF_IDLE' | null> = {
  BOOKED: null,
  CHECKED_IN: 'IN_WORKSHOP', INSPECTION: 'IN_WORKSHOP', DIAGNOSIS: 'IN_WORKSHOP',
  AWAITING_APPROVAL: 'REPAIR_REQUIRED',
  APPROVED: 'IN_WORKSHOP', IN_PROGRESS: 'IN_WORKSHOP', QUALITY_CHECK: 'IN_WORKSHOP', READY_FOR_COLLECTION: 'IN_WORKSHOP',
  AWAITING_PARTS: 'AWAITING_PARTS',
  ON_HOLD: null,
  COMPLETED: 'ACTIVE_IF_IDLE', CANCELLED: 'ACTIVE_IF_IDLE',
};

export async function applyWorkflowVehicleStatus(
  tx: Tx, ctx: Pick<BusinessContext, 'business' | 'user' | 'meta'>,
  job: { id: string; jobNumber: string; vehicleId: string; customerId: string }, jobStatus: string,
): Promise<void> {
  const rule = JOB_TO_VEHICLE[jobStatus];
  if (!rule) return;
  const vehicle = await tx.vehicle.findFirst({ where: { id: job.vehicleId, businessId: ctx.business.id } });
  if (!vehicle || vehicle.status === 'INACTIVE') return;
  let next: (typeof VEHICLE_STATUSES)[number];
  if (rule === 'ACTIVE_IF_IDLE') {
    const open = await tx.jobCard.count({ where: { businessId: ctx.business.id, vehicleId: job.vehicleId, id: { not: job.id }, status: { notIn: ['COMPLETED', 'CANCELLED', 'BOOKED'] } } });
    if (open > 0) return;
    next = 'ACTIVE';
  } else {
    next = rule;
  }
  if (vehicle.status === next) return;
  await tx.vehicle.update({ where: { id: vehicle.id }, data: { status: next } });
  const reason = `Job ${job.jobNumber} is ${labelOf(jobStatus)}`;
  await recordAudit(tx, ctx.meta, {
    action: AuditActions.vehicleStatusChanged, businessId: ctx.business.id, userId: ctx.user.id,
    resourceType: 'vehicle', resourceId: vehicle.id, before: { status: vehicle.status }, after: { status: next },
    metadata: { source: 'job_workflow', jobId: job.id, reason },
  });
  await recordActivity(tx, ctx.business.id, ctx.user.id, {
    type: 'vehicle.status_changed', summary: `Status ${labelOf(next)} (${reason})`, customerId: job.customerId, vehicleId: vehicle.id, jobId: job.id,
  });
}

// ───────────────────────── mileage ─────────────────────────

export type MileageSourceKey = 'CREATED' | 'MANUAL' | 'BOOKING' | 'CHECK_IN' | 'JOB_CREATED' | 'SERVICE' | 'JOB_COMPLETION' | 'CORRECTION';

/**
 * Record an odometer reading inside the caller's transaction. Readings never go backwards: a lower value is
 * refused (the person must ask someone who can correct mileage). The vehicle row is locked so two check-ins
 * at once cannot both pass the check.
 */
export async function recordMileageTx(
  tx: Tx, businessId: string, userId: string | null, vehicleId: string, mileageKm: number, source: MileageSourceKey,
  opts: { jobId?: string; bookingId?: string; note?: string } = {},
): Promise<{ changed: boolean; previousKm: number | null }> {
  const rows = await tx.$queryRaw<{ mileage_km: number | null }[]>`
    SELECT mileage_km FROM vehicles WHERE id = ${vehicleId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw Errors.notFound('Vehicle');
  const previousKm = rows[0]!.mileage_km;
  if (previousKm !== null && mileageKm < previousKm) {
    throw Errors.validation(
      { mileageKm: `The last recorded reading is ${previousKm.toLocaleString('en-ZA')} km. A lower reading needs a correction by someone authorised to correct mileage.` },
      'Mileage cannot go backwards.',
    );
  }
  await tx.vehicleMileage.create({
    data: { businessId, vehicleId, mileageKm, source, jobId: opts.jobId ?? null, bookingId: opts.bookingId ?? null, note: opts.note ?? null, recordedById: userId },
  });
  if (previousKm !== mileageKm) await tx.vehicle.update({ where: { id: vehicleId }, data: { mileageKm } });
  return { changed: previousKm !== mileageKm, previousKm };
}

export const mileageInputSchema = z.object({
  mileageKm: z.coerce.number().int('Enter whole kilometres').min(0).max(5_000_000),
  note: optionalText(300),
});

export async function recordMileage(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'vehicle.edit');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const { mileageKm, note } = parseOrThrow(mileageInputSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id } });
    if (!v) throw Errors.notFound('Vehicle');
    const r = await recordMileageTx(tx, ctx.business.id, ctx.user.id, vehicleId, mileageKm, 'MANUAL', { note });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.mileageRecorded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: vehicleId,
      before: { mileageKm: r.previousKm }, after: { mileageKm },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'vehicle.mileage_recorded', summary: `Mileage recorded: ${mileageKm.toLocaleString('en-ZA')} km`, customerId: v.customerId, vehicleId,
    });
    return tx.vehicle.findFirstOrThrow({ where: { id: vehicleId, businessId: ctx.business.id } });
  });
}

export const mileageCorrectionSchema = z.object({
  mileageKm: z.coerce.number().int('Enter whole kilometres').min(0).max(5_000_000),
  reason: z.string().trim().min(3, 'Explain why the reading is being corrected').max(300),
});

/** The only way to lower a recorded reading: an authorised person, with a reason, as a new history row. */
export async function correctMileage(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'vehicle.correct_mileage');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const { mileageKm, reason } = parseOrThrow(mileageCorrectionSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.$queryRaw<{ mileage_km: number | null; customer_id: string }[]>`
      SELECT mileage_km, customer_id FROM vehicles WHERE id = ${vehicleId}::uuid AND business_id = ${ctx.business.id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw Errors.notFound('Vehicle');
    const previous = rows[0]!;
    await tx.vehicleMileage.create({
      data: { businessId: ctx.business.id, vehicleId, mileageKm, source: 'CORRECTION', isCorrection: true, note: reason, recordedById: ctx.user.id },
    });
    await tx.vehicle.update({ where: { id: vehicleId }, data: { mileageKm } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.mileageCorrected, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: vehicleId,
      before: { mileageKm: previous.mileage_km }, after: { mileageKm }, metadata: { reason },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'vehicle.mileage_corrected', summary: `Mileage corrected to ${mileageKm.toLocaleString('en-ZA')} km`, customerId: previous.customer_id, vehicleId,
    });
    return tx.vehicle.findFirstOrThrow({ where: { id: vehicleId, businessId: ctx.business.id } });
  });
}

export async function listMileage(ctx: BusinessContext, id: string, query: unknown) {
  requirePermission(ctx, 'vehicle.view');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const q = parseOrThrow(paginationSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id }, select: { id: true } });
    if (!v) throw Errors.notFound('Vehicle');
    const where = { businessId: ctx.business.id, vehicleId };
    const [total, rows] = await seq([
      tx.vehicleMileage.count({ where }),
      tx.vehicleMileage.findMany({ where, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const ids = [...new Set(rows.map((r) => r.recordedById).filter((x): x is string => !!x))];
    const users = ids.length ? await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE id = ANY(${ids}::uuid[])` : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return { items: rows.map((r) => ({ ...r, recordedBy: r.recordedById ? (names.get(r.recordedById) ?? null) : null })), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

// ───────────────────────── authorised contacts ─────────────────────────

const contactSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  mobile: optionalText(30),
  email: optionalText(254),
  relationship: optionalText(60),
});

export async function addVehicleContact(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'vehicle.edit');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(contactSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId: ctx.business.id } });
    if (!v) throw Errors.notFound('Vehicle');
    const contact = await tx.vehicleContact.create({ data: { ...data, businessId: ctx.business.id, vehicleId } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: vehicleId,
      metadata: { authorisedContactAdded: contact.id },
    });
    return contact;
  });
}

export async function removeVehicleContact(ctx: BusinessContext, id: string, contactId: string) {
  requirePermission(ctx, 'vehicle.edit');
  const vehicleId = parseOrThrow(uuidSchema, id);
  const cId = parseOrThrow(uuidSchema, contactId);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await tx.vehicleContact.findFirst({ where: { id: cId, vehicleId, businessId: ctx.business.id } });
    if (!c) throw Errors.notFound('Contact');
    await tx.vehicleContact.delete({ where: { id: cId } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.vehicleUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: vehicleId,
      metadata: { authorisedContactRemoved: cId },
    });
  });
}
