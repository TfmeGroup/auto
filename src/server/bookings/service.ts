import { z } from 'zod';
import { withTenant, type Tx, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { addDays, dayRange, hhmmToMinutes, parseIsoDate, weekStart, zonedToUtc } from '@/lib/tz';
import { formatDateTime } from '@/lib/format';
import { optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { nextBookingNumber } from '@/server/numbering/sequence';
import { messageBooking, notifyBookingInternal } from './notify';
import { can, requirePermission } from '@/server/permissions/authorize';
import { recordMileageTx } from '@/server/vehicles/service';
import { assertAssignableTechnician, assertLocation, locationWhere, memberNames, visibleLocationIds } from '@/server/workshop/people';
import { loadRules } from '@/server/workshop/service';
import { evaluateSlot, loadAvailabilityData, lockBookingCalendar, type Conflict } from './availability';
import type { BusinessContext } from '@/server/context';

/**
 * Bookings. Every booking is a real row with its own number; recurring and waiting-list bookings are created
 * through the same code, so one set of availability rules applies everywhere. All writes happen under a
 * per-business calendar lock, inside one transaction, with an audit record, a booking-history row and a
 * timeline event.
 */

export const BOOKING_STATUSES = ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'CHECKED_IN', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED', 'COMPLETED'] as const;
/** Statuses that still hold a place in the diary. */
export const LIVE_STATUSES = ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'RESCHEDULED'] as const;
const MOVABLE = new Set<string>(LIVE_STATUSES);

const timeFields = {
  date: z.string().optional(),
  time: z.string().optional(),
  startsAt: z.coerce.date().optional(),
};

/** "2026-11-03" + "09:30" in the business's timezone, or an absolute ISO instant. */
export function resolveStart(input: { date?: string; time?: string; startsAt?: Date }, timezone: string): Date {
  if (input.startsAt) return input.startsAt;
  const d = input.date ? parseIsoDate(input.date) : null;
  const m = input.time ? hhmmToMinutes(input.time) : null;
  if (!d || m === null || m >= 1440) throw Errors.validation({ date: 'Choose a date and a time.' });
  return zonedToUtc(d.year, d.month, d.day, m, timezone);
}

const optionalUuid = z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined));
const durationField = z.union([z.literal(''), z.coerce.number().int('Enter whole minutes').min(5, 'At least 5 minutes').max(1440, 'At most 24 hours')]).optional().transform((v) => (v === '' ? undefined : v));

export const bookingInputSchema = z.object({
  customerId: uuidSchema,
  vehicleId: uuidSchema,
  serviceTypeId: optionalUuid,
  serviceLabel: optionalText(80),
  ...timeFields,
  durationMin: durationField,
  technicianMembershipId: optionalUuid,
  bayId: optionalUuid,
  locationId: optionalUuid,
  status: z.enum(['REQUESTED', 'CONFIRMED']).default('CONFIRMED'),
  customerNotes: optionalText(1000),
  internalNotes: optionalText(1000),
  expectedMileageKm: z.union([z.literal(''), z.coerce.number().int().min(0).max(5_000_000)]).optional().transform((v) => (v === '' ? undefined : v)),
  /** Deliberately book outside opening hours / on a technician's time off. Needs booking.manage. */
  allowOutsideHours: z.boolean().default(false),
  isWalkIn: z.boolean().default(false),
});

export const bookingUpdateSchema = z.object({
  serviceTypeId: optionalUuid,
  serviceLabel: optionalText(80),
  durationMin: durationField,
  technicianMembershipId: z.union([z.null(), z.literal(''), uuidSchema]).optional().transform((v) => (v === '' ? null : v)),
  bayId: z.union([z.null(), z.literal(''), uuidSchema]).optional().transform((v) => (v === '' ? null : v)),
  locationId: z.union([z.null(), z.literal(''), uuidSchema]).optional().transform((v) => (v === '' ? null : v)),
  customerNotes: optionalText(1000),
  internalNotes: optionalText(1000),
  allowOutsideHours: z.boolean().default(false),
});

export const rescheduleSchema = z.object({
  ...timeFields,
  technicianMembershipId: z.union([z.null(), z.literal(''), uuidSchema]).optional().transform((v) => (v === '' ? null : v)),
  bayId: z.union([z.null(), z.literal(''), uuidSchema]).optional().transform((v) => (v === '' ? null : v)),
  reason: optionalText(300),
  allowOutsideHours: z.boolean().default(false),
});

function conflictError(conflicts: Conflict[]) {
  return Errors.conflict(conflicts[0]!.message, { conflicts: conflicts.map((c) => ({ code: c.code, message: c.message, bookingId: c.bookingId })) });
}

/** Run the availability rules; soft conflicts are waived only for someone allowed to manage the calendar and who asked to. */
async function assertSlotFree(
  ctx: BusinessContext, tx: Tx,
  req: { startsAt: Date; endsAt: Date; technicianMembershipId?: string | null; bayId?: string | null; excludeBookingId?: string; isWalkIn?: boolean },
  allowOutsideHours: boolean,
): Promise<void> {
  const data = await loadAvailabilityData(tx, ctx.business.id, ctx.business.timezone, new Date(req.startsAt.getTime() - 86_400_000), new Date(req.endsAt.getTime() + 86_400_000));
  const waive = allowOutsideHours && can(ctx, 'booking.manage');
  if (allowOutsideHours && !can(ctx, 'booking.manage')) throw Errors.forbidden('Booking outside opening hours needs permission to manage the calendar.');
  const blocking = evaluateSlot(data, req).filter((c) => !(waive && c.soft));
  if (blocking.length > 0) throw conflictError(blocking);
}

async function loadRefs(tx: Tx, businessId: string, d: { customerId?: string; vehicleId?: string; serviceTypeId?: string | null; bayId?: string | null; locationId?: string | null; technicianMembershipId?: string | null }) {
  const customer = d.customerId ? await tx.customer.findFirst({ where: { id: d.customerId, businessId } }) : null;
  if (d.customerId && !customer) throw Errors.validation({ customerId: 'Choose a customer of this business.' });
  if (customer && customer.status === 'ARCHIVED') throw Errors.validation({ customerId: 'That customer is archived.' });
  const vehicle = d.vehicleId ? await tx.vehicle.findFirst({ where: { id: d.vehicleId, businessId } }) : null;
  if (d.vehicleId && !vehicle) throw Errors.validation({ vehicleId: 'Choose a vehicle of this business.' });
  if (vehicle && vehicle.archivedAt) throw Errors.validation({ vehicleId: 'That vehicle is archived.' });
  if (customer && vehicle && vehicle.customerId !== customer.id) {
    throw Errors.validation({ vehicleId: "That vehicle belongs to a different customer. Change the vehicle's owner first." });
  }
  const serviceType = d.serviceTypeId ? await tx.serviceType.findFirst({ where: { id: d.serviceTypeId, businessId } }) : null;
  if (d.serviceTypeId && !serviceType) throw Errors.validation({ serviceTypeId: 'Choose a service type of this business.' });
  if (d.bayId) {
    const bay = await tx.bay.findFirst({ where: { id: d.bayId, businessId, status: 'ACTIVE' } });
    if (!bay) throw Errors.validation({ bayId: 'Choose a bay of this business.' });
  }
  if (d.locationId) await assertLocation(tx, businessId, d.locationId);
  if (d.technicianMembershipId) await assertAssignableTechnician(tx, businessId, d.technicianMembershipId, 'technicianMembershipId');
  return { customer, vehicle, serviceType };
}

async function addEvent(
  tx: Tx, businessId: string, bookingId: string, userId: string | null,
  e: { type: string; fromStatus?: string; toStatus?: string; fromStartsAt?: Date; toStartsAt?: Date; fromTech?: string | null; toTech?: string | null; reason?: string | null },
) {
  await tx.bookingEvent.create({
    data: {
      businessId, bookingId, type: e.type, userId, reason: e.reason ?? null,
      fromStatus: (e.fromStatus as never) ?? null, toStatus: (e.toStatus as never) ?? null,
      fromStartsAt: e.fromStartsAt ?? null, toStartsAt: e.toStartsAt ?? null,
      fromTechnicianMembershipId: e.fromTech ?? null, toTechnicianMembershipId: e.toTech ?? null,
    },
  });
}

/** Shared by the API, recurring bookings and the waiting list: validate, check availability, insert, record. */
export async function createBookingTx(
  ctx: BusinessContext, tx: Tx, data: z.output<typeof bookingInputSchema>,
  extra: { recurringRuleId?: string; startsAtOverride?: Date } = {},
) {
  const businessId = ctx.business.id;
  const { customer, vehicle, serviceType } = await loadRefs(tx, businessId, data);
  const startsAt = extra.startsAtOverride ?? resolveStart(data, ctx.business.timezone);

  const defaultDuration = serviceType?.defaultDurationMin ?? 60;
  const durationMin = data.durationMin ?? defaultDuration;
  if (data.durationMin !== undefined && data.durationMin !== defaultDuration && !can(ctx, 'booking.edit')) {
    throw Errors.forbidden('Changing the duration needs permission to edit bookings.');
  }
  const serviceLabel = serviceType?.name ?? data.serviceLabel;
  if (!serviceLabel) throw Errors.validation({ serviceTypeId: 'Choose a service, or type what the booking is for.' });
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);

  await lockBookingCalendar(tx, businessId);
  await assertSlotFree(ctx, tx, { startsAt, endsAt, technicianMembershipId: data.technicianMembershipId, bayId: data.bayId, isWalkIn: data.isWalkIn }, data.allowOutsideHours);

  const bookingNumber = await nextBookingNumber(tx, businessId);
  const booking = await tx.booking.create({
    data: {
      businessId, bookingNumber, customerId: customer!.id, vehicleId: vehicle!.id,
      serviceTypeId: serviceType?.id ?? null, serviceLabel, startsAt, endsAt, durationMin,
      technicianMembershipId: data.technicianMembershipId ?? null, bayId: data.bayId ?? null, locationId: data.locationId ?? null,
      status: data.status, isWalkIn: data.isWalkIn, recurringRuleId: extra.recurringRuleId ?? null,
      customerNotes: data.customerNotes ?? null, internalNotes: data.internalNotes ?? null,
      expectedMileageKm: data.expectedMileageKm ?? null, createdById: ctx.user.id,
    },
  });
  if (data.expectedMileageKm !== undefined) {
    await recordMileageTx(tx, businessId, ctx.user.id, vehicle!.id, data.expectedMileageKm, 'BOOKING', { bookingId: booking.id });
  }
  await addEvent(tx, businessId, booking.id, ctx.user.id, { type: 'created', toStatus: booking.status, toStartsAt: startsAt, toTech: booking.technicianMembershipId });
  await recordAudit(tx, ctx.meta, {
    action: AuditActions.bookingCreated, businessId, userId: ctx.user.id, resourceType: 'booking', resourceId: booking.id, after: booking,
  });
  await recordActivity(tx, businessId, ctx.user.id, {
    type: 'booking.created', summary: `Booking ${bookingNumber} for ${serviceLabel} on ${formatDateTime(startsAt, ctx.business.timezone, ctx.business.locale)}`,
    customerId: customer!.id, vehicleId: vehicle!.id, bookingId: booking.id,
  });
  if (booking.status === 'CONFIRMED' && !booking.isWalkIn && !extra.recurringRuleId) await messageBooking(tx, ctx.business, 'BOOKING_CONFIRMED', booking, `bkconf:${booking.id}`);
  await notifyBookingInternal(tx, businessId, 'BOOKING_CREATED', booking, ctx.user.id, `New booking ${bookingNumber} for ${serviceLabel}`);
  return booking;
}

export async function createBooking(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.create');
  const data = parseOrThrow(bookingInputSchema, input);
  return withTenant(ctx.business.id, (tx) => createBookingTx(ctx, tx, data));
}

// ───────────────────────── reading ─────────────────────────

const bookingInclude = {
  customer: { select: { id: true, name: true, customerNumber: true, mobile: true, email: true } },
  vehicle: { select: { id: true, registration: true, make: true, model: true, colour: true, mileageKm: true } },
  job: { select: { id: true, jobNumber: true, status: true } },
} as const;

type BookingRow = Awaited<ReturnType<Tx['booking']['findFirstOrThrow']>>;

async function decorate<T extends BookingRow>(tx: Tx, businessId: string, rows: T[]) {
  const names = await memberNames(tx, businessId, rows.map((r) => r.technicianMembershipId));
  const bayIds = [...new Set(rows.map((r) => r.bayId).filter((v): v is string => !!v))];
  const bays = bayIds.length ? await tx.bay.findMany({ where: { id: { in: bayIds }, businessId }, select: { id: true, name: true } }) : [];
  const bayName = new Map(bays.map((b) => [b.id, b.name]));
  return rows.map((r) => ({
    ...r,
    technicianName: r.technicianMembershipId ? (names.get(r.technicianMembershipId) ?? null) : null,
    bayName: r.bayId ? (bayName.get(r.bayId) ?? null) : null,
  }));
}

export async function getBooking(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'booking.view');
  const bookingId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const b = await tx.booking.findFirst({ where: { id: bookingId, businessId: ctx.business.id, ...locationWhere(scope) }, include: bookingInclude });
    if (!b) throw Errors.notFound('Booking');
    const [row] = await decorate(tx, ctx.business.id, [b]);
    const events = await tx.bookingEvent.findMany({ where: { businessId: ctx.business.id, bookingId }, orderBy: { createdAt: 'asc' } });
    return { ...row!, events };
  });
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-03').refine((s) => !!parseIsoDate(s), 'Invalid date');

export const bookingFilterSchema = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  technicianId: uuidSchema.optional(),
  serviceTypeId: uuidSchema.optional(),
  bayId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  vehicleId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  q: z.string().trim().max(100).optional(),
});

export const bookingListSchema = paginationSchema.merge(bookingFilterSchema).extend({
  dir: z.enum(['asc', 'desc']).default('asc'),
});

function filterWhere(ctx: BusinessContext, f: z.output<typeof bookingFilterSchema>, scope: string[] | null) {
  const tz = ctx.business.timezone;
  return {
    businessId: ctx.business.id,
    ...locationWhere(scope),
    ...(f.status ? { status: f.status } : {}),
    ...(f.technicianId ? { technicianMembershipId: f.technicianId } : {}),
    ...(f.serviceTypeId ? { serviceTypeId: f.serviceTypeId } : {}),
    ...(f.bayId ? { bayId: f.bayId } : {}),
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
    ...(f.locationId ? { locationId: f.locationId } : {}),
    ...(f.from || f.to
      ? { startsAt: { ...(f.from ? { gte: dayRange(f.from, tz).start } : {}), ...(f.to ? { lt: dayRange(f.to, tz).end } : {}) } }
      : {}),
    ...(f.q
      ? {
          AND: f.q.split(/\s+/).filter(Boolean).slice(0, 5).map((w) => ({
            OR: [
              { bookingNumber: { contains: w, mode: 'insensitive' as const } },
              { customer: { name: { contains: w, mode: 'insensitive' as const } } },
              { vehicle: { registrationNorm: { contains: w.toUpperCase().replace(/[^A-Z0-9]/g, '') || w, mode: 'insensitive' as const } } },
              { vehicle: { model: { contains: w, mode: 'insensitive' as const } } },
              { serviceLabel: { contains: w, mode: 'insensitive' as const } },
            ],
          })),
        }
      : {}),
  };
}

export async function listBookings(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'booking.view');
  const q = parseOrThrow(bookingListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const where = filterWhere(ctx, q, scope);
    const [total, rows] = await seq([
      tx.booking.count({ where }),
      tx.booking.findMany({ where, include: bookingInclude, orderBy: [{ startsAt: q.dir }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: await decorate(tx, ctx.business.id, rows), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

export const calendarQuerySchema = bookingFilterSchema.omit({ from: true, to: true }).extend({
  view: z.enum(['day', 'week', 'month']).default('week'),
  date: isoDay,
});

/**
 * The bookings shown on a calendar page. Day = that day, week = Monday to Sunday, month = the whole 6-week grid
 * the month view draws. Capped, so a pathological month cannot load without bound.
 */
export async function getCalendar(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'booking.view');
  const q = parseOrThrow(calendarQuerySchema, query);
  const tz = ctx.business.timezone;
  let first = q.date;
  let days = 1;
  if (q.view === 'week') { first = weekStart(q.date); days = 7; }
  if (q.view === 'month') {
    const p = parseIsoDate(q.date)!;
    first = weekStart(`${p.year}-${String(p.month).padStart(2, '0')}-01`);
    days = 42;
  }
  const from = dayRange(first, tz).start;
  const to = dayRange(addDays(first, days - 1), tz).end;
  const CAP = 600;
  return withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const base = filterWhere(ctx, { ...q }, scope);
    const where = { ...base, startsAt: { gte: from, lt: to } };
    const rows = await tx.booking.findMany({ where, include: bookingInclude, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], take: CAP + 1 });
    const items = await decorate(tx, ctx.business.id, rows.slice(0, CAP));
    return { view: q.view, firstDay: first, days, from, to, items, truncated: rows.length > CAP };
  });
}

// ───────────────────────── availability for the booking form ─────────────────────────

export const slotsQuerySchema = z.object({
  date: isoDay,
  durationMin: z.coerce.number().int().min(5).max(1440).default(60),
  technicianId: uuidSchema.optional(),
  bayId: uuidSchema.optional(),
  stepMin: z.coerce.number().int().min(5).max(120).default(30),
});

/** Start times that are free for a given day, technician and duration (same rules as creating the booking). */
export async function findFreeSlots(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'booking.view');
  const q = parseOrThrow(slotsQuerySchema, query);
  const tz = ctx.business.timezone;
  const { start, end } = dayRange(q.date, tz);
  return withTenant(ctx.business.id, async (tx) => {
    const data = await loadAvailabilityData(tx, ctx.business.id, tz, new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000));
    const slots: string[] = [];
    const p = parseIsoDate(q.date)!;
    for (let m = 0; m < 1440; m += q.stepMin) {
      const startsAt = zonedToUtc(p.year, p.month, p.day, m, tz);
      const endsAt = new Date(startsAt.getTime() + q.durationMin * 60_000);
      if (evaluateSlot(data, { startsAt, endsAt, technicianMembershipId: q.technicianId, bayId: q.bayId }).length === 0) {
        slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
      }
    }
    return { date: q.date, slots };
  });
}

// ───────────────────────── changing a booking ─────────────────────────

async function lockBooking(tx: Tx, ctx: BusinessContext, id: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bookings WHERE id = ${id}::uuid AND business_id = ${ctx.business.id}::uuid FOR UPDATE`;
  if (locked.length === 0) throw Errors.notFound('Booking');
  return tx.booking.findFirstOrThrow({ where: { id, businessId: ctx.business.id } });
}

export async function updateBooking(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'booking.edit');
  const bookingId = parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(bookingUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await lockBookingCalendar(tx, ctx.business.id);
    const before = await lockBooking(tx, ctx, bookingId);
    if (!MOVABLE.has(before.status)) throw Errors.conflict(`A ${before.status.toLowerCase().replace('_', ' ')} booking can no longer be edited.`);

    const refs = await loadRefs(tx, ctx.business.id, { serviceTypeId: data.serviceTypeId, bayId: data.bayId, locationId: data.locationId, technicianMembershipId: data.technicianMembershipId });
    const patch: Record<string, unknown> = {};
    if (data.serviceTypeId) { patch.serviceTypeId = refs.serviceType!.id; patch.serviceLabel = refs.serviceType!.name; }
    else if (data.serviceLabel) { patch.serviceLabel = data.serviceLabel; patch.serviceTypeId = null; }
    if (data.customerNotes !== undefined) patch.customerNotes = data.customerNotes;
    if (data.internalNotes !== undefined) patch.internalNotes = data.internalNotes;
    if (data.technicianMembershipId !== undefined) patch.technicianMembershipId = data.technicianMembershipId;
    if (data.bayId !== undefined) patch.bayId = data.bayId;
    if (data.locationId !== undefined) patch.locationId = data.locationId;

    let durationMin = before.durationMin;
    if (data.durationMin !== undefined) durationMin = data.durationMin;
    else if (data.serviceTypeId && refs.serviceType) durationMin = refs.serviceType.defaultDurationMin;
    patch.durationMin = durationMin;
    const endsAt = new Date(before.startsAt.getTime() + durationMin * 60_000);
    patch.endsAt = endsAt;

    const tech = data.technicianMembershipId !== undefined ? data.technicianMembershipId : before.technicianMembershipId;
    const bay = data.bayId !== undefined ? data.bayId : before.bayId;
    const changesSlot = durationMin !== before.durationMin || tech !== before.technicianMembershipId || bay !== before.bayId;
    if (changesSlot) await assertSlotFree(ctx, tx, { startsAt: before.startsAt, endsAt, technicianMembershipId: tech, bayId: bay, excludeBookingId: before.id }, data.allowOutsideHours);

    const after = await tx.booking.update({ where: { id: bookingId }, data: patch });
    if (tech !== before.technicianMembershipId) {
      await addEvent(tx, ctx.business.id, bookingId, ctx.user.id, { type: 'technician_changed', fromTech: before.technicianMembershipId, toTech: tech });
    }
    await recordAudit(tx, ctx.meta, { action: AuditActions.bookingUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'booking', resourceId: bookingId, before, after });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'booking.updated', summary: `Booking ${after.bookingNumber} updated`, customerId: after.customerId, vehicleId: after.vehicleId, bookingId,
    });
    return after;
  });
}

export async function rescheduleBooking(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'booking.reschedule');
  const bookingId = parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(rescheduleSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await lockBookingCalendar(tx, ctx.business.id);
    const before = await lockBooking(tx, ctx, bookingId);
    if (!MOVABLE.has(before.status)) throw Errors.conflict(`A ${before.status.toLowerCase().replace('_', ' ')} booking cannot be rescheduled.`);
    const rules = await loadRules(tx, ctx.business.id);
    if (rules.requireRescheduleReason && !data.reason) throw Errors.validation({ reason: 'Enter a reason for moving this booking.' });

    const startsAt = resolveStart(data, ctx.business.timezone);
    const endsAt = new Date(startsAt.getTime() + before.durationMin * 60_000);
    const tech = data.technicianMembershipId !== undefined ? data.technicianMembershipId : before.technicianMembershipId;
    const bay = data.bayId !== undefined ? data.bayId : before.bayId;
    await loadRefs(tx, ctx.business.id, { bayId: data.bayId, technicianMembershipId: data.technicianMembershipId });
    if (startsAt.getTime() === before.startsAt.getTime() && tech === before.technicianMembershipId && bay === before.bayId) {
      throw Errors.validation({ date: 'That is the time the booking already has.' });
    }
    await assertSlotFree(ctx, tx, { startsAt, endsAt, technicianMembershipId: tech, bayId: bay, excludeBookingId: before.id }, data.allowOutsideHours);

    const after = await tx.booking.update({
      where: { id: bookingId },
      data: { startsAt, endsAt, technicianMembershipId: tech, bayId: bay, status: 'RESCHEDULED', reminderSentAt: null },
    });
    await addEvent(tx, ctx.business.id, bookingId, ctx.user.id, {
      type: 'rescheduled', fromStatus: before.status, toStatus: 'RESCHEDULED', fromStartsAt: before.startsAt, toStartsAt: startsAt,
      fromTech: before.technicianMembershipId, toTech: tech, reason: data.reason,
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.bookingRescheduled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'booking', resourceId: bookingId,
      before: { startsAt: before.startsAt, technician: before.technicianMembershipId, bay: before.bayId }, after: { startsAt, technician: tech, bay },
      metadata: { reason: data.reason },
    });
    const fmt = (d: Date) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'booking.rescheduled', summary: `Booking ${after.bookingNumber} moved from ${fmt(before.startsAt)} to ${fmt(startsAt)}`,
      customerId: after.customerId, vehicleId: after.vehicleId, bookingId,
    });

    // Tell the customer, when the business has that switched on and we have an address.
    if (rules.notifyCustomerReschedule) {
      await messageBooking(tx, ctx.business, 'BOOKING_RESCHEDULED', after, `booking-resched:${bookingId}:${startsAt.getTime()}`, before.startsAt);
    }
    await notifyBookingInternal(tx, ctx.business.id, 'BOOKING_CHANGED', after, ctx.user.id, `Booking ${after.bookingNumber} was moved to ${fmt(startsAt)}`);
    return after;
  });
}

export const cancelSchema = z.object({ reason: optionalText(300) });

export async function cancelBooking(ctx: BusinessContext, id: string, input: unknown = {}) {
  requirePermission(ctx, 'booking.cancel');
  const bookingId = parseOrThrow(uuidSchema, id);
  const { reason } = parseOrThrow(cancelSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await lockBooking(tx, ctx, bookingId);
    if (!MOVABLE.has(before.status)) throw Errors.conflict(`A ${before.status.toLowerCase().replace('_', ' ')} booking cannot be cancelled.`);
    // A late cancellation (inside the business's cancellation window) is a deliberate step for someone who manages the calendar.
    const settings = await loadRules(tx, ctx.business.id);
    const late = settings.cancelWindowHours > 0 && before.startsAt.getTime() - Date.now() < settings.cancelWindowHours * 3_600_000;
    if (late && !can(ctx, 'booking.manage')) throw Errors.forbidden(`This booking starts within ${settings.cancelWindowHours} hour${settings.cancelWindowHours === 1 ? '' : 's'}. Only someone who manages the calendar can cancel it now.`);
    const after = await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: ctx.user.id, cancelReason: reason ?? null } });
    await addEvent(tx, ctx.business.id, bookingId, ctx.user.id, { type: 'cancelled', fromStatus: before.status, toStatus: 'CANCELLED', reason });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.bookingCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'booking', resourceId: bookingId,
      before: { status: before.status }, after: { status: 'CANCELLED' }, metadata: { reason, ...(late ? { lateCancellation: true } : {}) },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'booking.cancelled', summary: `Booking ${after.bookingNumber} cancelled${reason ? ` — ${reason}` : ''}`, customerId: after.customerId, vehicleId: after.vehicleId, bookingId,
    });
    const rules = await loadRules(tx, ctx.business.id);
    if (rules.notifyCustomerCancel) {
      await messageBooking(tx, ctx.business, 'BOOKING_CANCELLED', before, `booking-cancel:${bookingId}`);
    }
    await notifyBookingInternal(tx, ctx.business.id, 'BOOKING_CANCELLED', after, ctx.user.id, `Booking ${after.bookingNumber} was cancelled`);
    return after;
  });
}

/** Status changes that are not their own workflow: confirm a request, note that a reminder went out, or record a no-show. */
export const bookingStatusSchema = z.object({ status: z.enum(['CONFIRMED', 'REMINDER_SENT', 'NO_SHOW']), reason: optionalText(300) });

const STATUS_FROM: Record<'CONFIRMED' | 'REMINDER_SENT' | 'NO_SHOW', string[]> = {
  CONFIRMED: ['REQUESTED'],
  REMINDER_SENT: ['CONFIRMED', 'RESCHEDULED'],
  NO_SHOW: ['CONFIRMED', 'REMINDER_SENT', 'RESCHEDULED', 'REQUESTED'],
};

export async function setBookingStatus(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'booking.edit');
  const bookingId = parseOrThrow(uuidSchema, id);
  const { status, reason } = parseOrThrow(bookingStatusSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await lockBooking(tx, ctx, bookingId);
    if (!STATUS_FROM[status].includes(before.status)) {
      throw Errors.conflict(`A booking that is ${before.status.toLowerCase().replace('_', ' ')} cannot be marked ${status.toLowerCase().replace('_', ' ')}.`);
    }
    if (status === 'NO_SHOW' && before.startsAt.getTime() > Date.now()) throw Errors.conflict('A booking can only be marked as a no-show after its start time has passed.');
    const after = await tx.booking.update({ where: { id: bookingId }, data: { status, ...(status === 'REMINDER_SENT' ? { reminderSentAt: new Date() } : {}) } });
    await addEvent(tx, ctx.business.id, bookingId, ctx.user.id, { type: 'status_changed', fromStatus: before.status, toStatus: status, reason });
    await recordAudit(tx, ctx.meta, {
      action: status === 'NO_SHOW' ? AuditActions.bookingNoShow : AuditActions.bookingStatusChanged, businessId: ctx.business.id, userId: ctx.user.id,
      resourceType: 'booking', resourceId: bookingId, before: { status: before.status }, after: { status }, metadata: { reason },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'booking.status_changed', summary: `Booking ${after.bookingNumber} marked ${status.toLowerCase().replace('_', ' ')}`, customerId: after.customerId, vehicleId: after.vehicleId, bookingId,
    });
    if (status === 'CONFIRMED') await messageBooking(tx, ctx.business, 'BOOKING_CONFIRMED', after, `bkconf:${bookingId}`);
    if (status === 'NO_SHOW') await messageBooking(tx, ctx.business, 'BOOKING_NO_SHOW', after, `bknoshow:${bookingId}`);
    return after;
  });
}

export { addEvent as addBookingEvent, lockBooking };
