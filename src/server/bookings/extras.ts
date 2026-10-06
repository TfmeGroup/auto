import { z } from 'zod';
import { withTenant, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { addDays, addMonths, hhmmToMinutes, isoDate, parseIsoDate, zonedToUtc } from '@/lib/tz';
import { optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { requirePermission } from '@/server/permissions/authorize';
import { evaluateSlot, loadAvailabilityData, lockBookingCalendar } from './availability';
import { loadRules } from '@/server/workshop/service';
import { bookingInputSchema, createBookingTx, LIVE_STATUSES } from './service';
import type { BusinessContext } from '@/server/context';

// ───────────────────────── waiting list ─────────────────────────

const optionalUuid = z.union([z.literal(''), uuidSchema]).optional().transform((v) => (v ? v : undefined));
const timeOfDay = z.union([z.literal(''), z.string()]).optional().transform((v, c) => {
  if (!v) return undefined;
  const m = hhmmToMinutes(v);
  if (m === null) c.addIssue({ code: 'custom', message: 'Use a time like 09:00' });
  return m ?? undefined;
});

export const waitingSchema = z.object({
  customerId: uuidSchema,
  vehicleId: optionalUuid,
  serviceTypeId: optionalUuid,
  serviceLabel: optionalText(80),
  preferredDate: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional().transform((v) => (v ? v : undefined)),
  preferredFrom: timeOfDay,
  preferredTo: timeOfDay,
  contactPreference: z.union([z.literal(''), z.enum(['PHONE', 'SMS', 'WHATSAPP', 'EMAIL'])]).optional().transform((v) => (v ? v : undefined)),
  notes: optionalText(1000),
}).superRefine((v, ctx) => {
  if ((v.preferredFrom === undefined) !== (v.preferredTo === undefined)) ctx.addIssue({ code: 'custom', path: ['preferredTo'], message: 'Give both a start and an end time, or neither' });
  else if (v.preferredFrom !== undefined && v.preferredTo !== undefined && v.preferredFrom >= v.preferredTo) ctx.addIssue({ code: 'custom', path: ['preferredTo'], message: 'The end must be after the start' });
  if (v.preferredDate && !parseIsoDate(v.preferredDate)) ctx.addIssue({ code: 'custom', path: ['preferredDate'], message: 'Invalid date' });
});

export async function addWaitingEntry(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.create');
  const d = parseOrThrow(waitingSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    if (!(await loadRules(tx, ctx.business.id)).waitingListEnabled) throw Errors.conflict('The waiting list is switched off for this workshop (Settings, Bookings).');
    const customer = await tx.customer.findFirst({ where: { id: d.customerId, businessId: ctx.business.id } });
    if (!customer || customer.status === 'ARCHIVED') throw Errors.validation({ customerId: 'Choose an active customer of this business.' });
    if (d.vehicleId) {
      const v = await tx.vehicle.findFirst({ where: { id: d.vehicleId, businessId: ctx.business.id, archivedAt: null } });
      if (!v) throw Errors.validation({ vehicleId: 'Choose a vehicle of this business.' });
      if (v.customerId !== customer.id) throw Errors.validation({ vehicleId: 'That vehicle belongs to a different customer.' });
    }
    const type = d.serviceTypeId ? await tx.serviceType.findFirst({ where: { id: d.serviceTypeId, businessId: ctx.business.id } }) : null;
    if (d.serviceTypeId && !type) throw Errors.validation({ serviceTypeId: 'Choose a service type of this business.' });
    const label = type?.name ?? d.serviceLabel;
    if (!label) throw Errors.validation({ serviceTypeId: 'Choose the service the customer wants.' });
    const row = await tx.waitingListEntry.create({
      data: {
        businessId: ctx.business.id, customerId: d.customerId, vehicleId: d.vehicleId ?? null, serviceTypeId: type?.id ?? null, serviceLabel: label,
        preferredDate: d.preferredDate ? new Date(`${d.preferredDate}T00:00:00Z`) : null, preferredStartMinute: d.preferredFrom ?? null, preferredEndMinute: d.preferredTo ?? null,
        contactPreference: d.contactPreference ?? null, notes: d.notes ?? null, createdById: ctx.user.id,
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.waitingListAdded, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'waiting_list', resourceId: row.id, after: row });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'booking.waiting_list_added', summary: `Added to the waiting list for ${label}`, customerId: d.customerId, vehicleId: d.vehicleId });
    return row;
  });
}

export const waitingListQuerySchema = paginationSchema.extend({ status: z.enum(['WAITING', 'CONTACTED', 'BOOKED', 'CANCELLED']).optional() });

export async function listWaitingEntries(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'booking.view');
  const q = parseOrThrow(waitingListQuerySchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const where = { businessId: ctx.business.id, ...(q.status ? { status: q.status } : { status: { in: ['WAITING', 'CONTACTED'] as ('WAITING' | 'CONTACTED')[] } }) };
    const [total, rows] = await seq([
      tx.waitingListEntry.count({ where }),
      tx.waitingListEntry.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const customers = await tx.customer.findMany({ where: { businessId: ctx.business.id, id: { in: rows.map((r) => r.customerId) } }, select: { id: true, name: true, mobile: true, customerNumber: true } });
    const vehicles = await tx.vehicle.findMany({ where: { businessId: ctx.business.id, id: { in: rows.flatMap((r) => (r.vehicleId ? [r.vehicleId] : [])) } }, select: { id: true, registration: true, make: true, model: true } });
    const cMap = new Map(customers.map((c) => [c.id, c]));
    const vMap = new Map(vehicles.map((v) => [v.id, v]));
    return { items: rows.map((r) => ({ ...r, customer: cMap.get(r.customerId) ?? null, vehicle: r.vehicleId ? (vMap.get(r.vehicleId) ?? null) : null })), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

export async function setWaitingStatus(ctx: BusinessContext, id: string, status: unknown) {
  requirePermission(ctx, 'booking.edit');
  const entryId = parseOrThrow(uuidSchema, id);
  const s = parseOrThrow(z.enum(['CONTACTED', 'CANCELLED']), status);
  return withTenant(ctx.business.id, async (tx) => {
    const e = await tx.waitingListEntry.findFirst({ where: { id: entryId, businessId: ctx.business.id } });
    if (!e) throw Errors.notFound('Waiting list entry');
    if (!['WAITING', 'CONTACTED'].includes(e.status)) throw Errors.conflict('This entry is already closed.');
    const after = await tx.waitingListEntry.update({ where: { id: entryId }, data: { status: s } });
    if (s === 'CANCELLED') await recordAudit(tx, ctx.meta, { action: AuditActions.waitingListCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'waiting_list', resourceId: entryId });
    return after;
  });
}

/**
 * Move a waiting customer into a real booking. This is an explicit act by staff choosing the slot — nothing is booked
 * automatically when space appears — and it uses the normal booking rules, so a conflicting slot is refused.
 */
export async function convertWaitingEntry(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'booking.create');
  const entryId = parseOrThrow(uuidSchema, id);
  const slot = parseOrThrow(bookingInputSchema.partial({ customerId: true, vehicleId: true }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM waiting_list_entries WHERE id = ${entryId}::uuid AND business_id = ${ctx.business.id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw Errors.notFound('Waiting list entry');
    const e = await tx.waitingListEntry.findFirstOrThrow({ where: { id: entryId, businessId: ctx.business.id } });
    if (!['WAITING', 'CONTACTED'].includes(e.status)) throw Errors.conflict('This entry has already been booked or closed.');
    const vehicleId = slot.vehicleId ?? e.vehicleId;
    if (!vehicleId) throw Errors.validation({ vehicleId: 'Choose the vehicle for this booking.' });
    const booking = await createBookingTx(ctx, tx, {
      ...slot, customerId: e.customerId, vehicleId, serviceTypeId: slot.serviceTypeId ?? e.serviceTypeId ?? undefined,
      serviceLabel: slot.serviceLabel ?? e.serviceLabel, customerNotes: slot.customerNotes ?? e.notes ?? undefined,
    });
    await tx.waitingListEntry.update({ where: { id: entryId }, data: { status: 'BOOKED', bookingId: booking.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.waitingListBooked, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'waiting_list', resourceId: entryId, metadata: { bookingId: booking.id } });
    return booking;
  });
}

// ───────────────────────── recurring bookings ─────────────────────────

const MAX_OCCURRENCES = 104;

export const recurringSchema = z.object({
  customerId: uuidSchema,
  vehicleId: uuidSchema,
  serviceTypeId: optionalUuid,
  serviceLabel: optionalText(80),
  technicianMembershipId: optionalUuid,
  bayId: optionalUuid,
  locationId: optionalUuid,
  frequency: z.enum(['WEEKLY', 'MONTHLY']),
  intervalCount: z.coerce.number().int().min(1).max(52).default(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a start date').refine((s) => !!parseIsoDate(s), 'Invalid date'),
  time: z.string().refine((s) => hhmmToMinutes(s) !== null, 'Use a time like 09:00'),
  durationMin: z.union([z.literal(''), z.coerce.number().int().min(5).max(1440)]).optional().transform((v) => (v === '' ? undefined : v)),
  endDate: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional().transform((v) => (v ? v : undefined)),
  occurrences: z.union([z.literal(''), z.coerce.number().int().min(1).max(MAX_OCCURRENCES)]).optional().transform((v) => (v === '' ? undefined : v)),
  customerNotes: optionalText(1000),
  internalNotes: optionalText(1000),
  allowOutsideHours: z.boolean().default(false),
}).superRefine((v, ctx) => {
  if (!v.endDate && !v.occurrences) ctx.addIssue({ code: 'custom', path: ['occurrences'], message: 'Set an end date or a number of occurrences. Open-ended series are not created.' });
  if (v.endDate && v.endDate < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date must be on or after the start date' });
});

/** The local dates of a series. Each is computed from the start (31 Jan + 1 month = 28 Feb, then 31 Mar — no drift). */
export function recurrenceDates(startDate: string, frequency: 'WEEKLY' | 'MONTHLY', intervalCount: number, endDate?: string, occurrences?: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < MAX_OCCURRENCES; k++) {
    const d = frequency === 'WEEKLY' ? addDays(startDate, 7 * intervalCount * k) : addMonths(startDate, intervalCount * k);
    if (endDate && d > endDate) break;
    if (occurrences !== undefined && out.length >= occurrences) break;
    out.push(d);
  }
  return out;
}

/**
 * Create a recurring series: one rule plus one REAL booking per occurrence (never a single record standing for
 * many). Occurrences that cannot be booked (a clash, a closed day, a date in the past) are skipped and reported
 * back, not squeezed in somewhere else.
 */
export async function createRecurringSeries(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.create');
  const d = parseOrThrow(recurringSchema, input);
  const dates = recurrenceDates(d.startDate, d.frequency, d.intervalCount, d.endDate, d.occurrences);
  if (dates.length === 0) throw Errors.validation({ startDate: 'No dates fall inside that range.' });
  const startMinute = hhmmToMinutes(d.time)!;
  const tz = ctx.business.timezone;

  return withTenant(ctx.business.id, async (tx) => {
    await lockBookingCalendar(tx, ctx.business.id);
    const type = d.serviceTypeId ? await tx.serviceType.findFirst({ where: { id: d.serviceTypeId, businessId: ctx.business.id } }) : null;
    if (d.serviceTypeId && !type) throw Errors.validation({ serviceTypeId: 'Choose a service type of this business.' });
    const label = type?.name ?? d.serviceLabel;
    if (!label) throw Errors.validation({ serviceTypeId: 'Choose a service, or type what the bookings are for.' });
    const durationMin = d.durationMin ?? type?.defaultDurationMin ?? 60;

    const rule = await tx.recurringBookingRule.create({
      data: {
        businessId: ctx.business.id, customerId: d.customerId, vehicleId: d.vehicleId, serviceTypeId: type?.id ?? null, serviceLabel: label,
        technicianMembershipId: d.technicianMembershipId ?? null, bayId: d.bayId ?? null, locationId: d.locationId ?? null,
        frequency: d.frequency, intervalCount: d.intervalCount, startDate: new Date(`${d.startDate}T00:00:00Z`), startMinute, durationMin,
        endDate: d.endDate ? new Date(`${d.endDate}T00:00:00Z`) : null, occurrences: d.occurrences ?? null, notes: d.internalNotes ?? null, createdById: ctx.user.id,
      },
    });

    const first = zonedToUtc(...ymd(dates[0]!), 0, tz);
    const last = zonedToUtc(...ymd(dates[dates.length - 1]!), 24 * 60, tz);
    const data = await loadAvailabilityData(tx, ctx.business.id, tz, first, last);
    const created = [];
    const skipped: { date: string; reasons: string[] }[] = [];
    for (const date of dates) {
      const startsAt = zonedToUtc(...ymd(date), startMinute, tz);
      const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
      const conflicts = evaluateSlot(data, { startsAt, endsAt, technicianMembershipId: d.technicianMembershipId, bayId: d.bayId })
        .filter((c) => !(d.allowOutsideHours && c.soft));
      if (conflicts.length > 0) {
        skipped.push({ date, reasons: conflicts.map((c) => c.message) });
        continue;
      }
      const b = await createBookingTx(
        ctx, tx,
        {
          customerId: d.customerId, vehicleId: d.vehicleId, serviceTypeId: type?.id, serviceLabel: label, durationMin, technicianMembershipId: d.technicianMembershipId,
          bayId: d.bayId, locationId: d.locationId, status: 'CONFIRMED', customerNotes: d.customerNotes, internalNotes: d.internalNotes, expectedMileageKm: undefined, allowOutsideHours: d.allowOutsideHours, isWalkIn: false,
        },
        { recurringRuleId: rule.id, startsAtOverride: startsAt },
      );
      data.bookings.push({ id: b.id, bookingNumber: b.bookingNumber, startsAt: b.startsAt, endsAt: b.endsAt, technicianMembershipId: b.technicianMembershipId, bayId: b.bayId });
      created.push(b);
    }
    if (created.length === 0) throw Errors.conflict('None of the dates could be booked.', { skipped });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.recurringCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'recurring_booking_rule', resourceId: rule.id,
      after: rule, metadata: { created: created.length, skipped: skipped.length },
    });
    return { rule, created, skipped };
  });
}

function ymd(date: string): [number, number, number] {
  const p = parseIsoDate(date)!;
  return [p.year, p.month, p.day];
}

export async function listRecurringRules(ctx: BusinessContext) {
  requirePermission(ctx, 'booking.view');
  return withTenant(ctx.business.id, async (tx) => {
    const rules = await tx.recurringBookingRule.findMany({ where: { businessId: ctx.business.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    const counts = await tx.booking.groupBy({ by: ['recurringRuleId'], where: { businessId: ctx.business.id, recurringRuleId: { in: rules.map((r) => r.id) }, status: { in: [...LIVE_STATUSES] }, startsAt: { gte: new Date() } }, _count: true });
    const upcoming = new Map(counts.map((c) => [c.recurringRuleId, c._count]));
    return rules.map((r) => ({ ...r, upcomingBookings: upcoming.get(r.id) ?? 0, startDate: isoDate(r.startDate.getUTCFullYear(), r.startDate.getUTCMonth() + 1, r.startDate.getUTCDate()) }));
  });
}

/** Stop a series: future, not-yet-arrived bookings of the rule are cancelled (each one audited); past ones are untouched. */
export async function cancelRecurringSeries(ctx: BusinessContext, id: string, input: unknown = {}) {
  requirePermission(ctx, 'booking.cancel');
  const ruleId = parseOrThrow(uuidSchema, id);
  const { reason } = parseOrThrow(z.object({ reason: optionalText(300) }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const rule = await tx.recurringBookingRule.findFirst({ where: { id: ruleId, businessId: ctx.business.id } });
    if (!rule) throw Errors.notFound('Recurring series');
    if (rule.status !== 'ACTIVE') throw Errors.conflict('This series is already stopped.');
    const future = await tx.booking.findMany({ where: { businessId: ctx.business.id, recurringRuleId: ruleId, status: { in: [...LIVE_STATUSES] }, startsAt: { gte: new Date() } } });
    const now = new Date();
    for (const b of future) {
      await tx.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelledById: ctx.user.id, cancelReason: reason ?? 'Recurring series stopped' } });
      await tx.bookingEvent.create({ data: { businessId: ctx.business.id, bookingId: b.id, type: 'cancelled', fromStatus: b.status, toStatus: 'CANCELLED', reason: reason ?? 'Recurring series stopped', userId: ctx.user.id } });
      await recordAudit(tx, ctx.meta, { action: AuditActions.bookingCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'booking', resourceId: b.id, before: { status: b.status }, after: { status: 'CANCELLED' }, metadata: { recurringRuleId: ruleId } });
    }
    await tx.recurringBookingRule.update({ where: { id: ruleId }, data: { status: 'CANCELLED' } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.recurringCancelled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'recurring_booking_rule', resourceId: ruleId, metadata: { cancelledBookings: future.length, reason } });
    return { cancelled: future.length };
  });
}
