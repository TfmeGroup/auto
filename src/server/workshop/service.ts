import { z } from 'zod';
import { Prisma, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { hhmmToMinutes } from '@/lib/tz';
import { optionalText, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { requireAnyPermission, requirePermission } from '@/server/permissions/authorize';
import { assertActiveMember, assertLocation, listTechnicians, memberNames } from './people';
import type { BusinessContext } from '@/server/context';

/**
 * Workshop configuration: the service catalogue, bays, opening hours, technician working hours and time off,
 * and the booking rules. Reading is open to anyone who works with bookings or jobs (they need these lists to
 * fill in forms); changing any of it needs booking.manage.
 */

const canRead = (ctx: BusinessContext) => requireAnyPermission(ctx, ['booking.view', 'job.view', 'booking.manage']);

// ───────────────────────── service types ─────────────────────────

export const serviceTypeSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  defaultDurationMin: z.coerce.number().int('Enter whole minutes').min(5, 'At least 5 minutes').max(1440, 'At most 24 hours'),
});

export async function listServiceTypes(ctx: BusinessContext, opts: { includeArchived?: boolean } = {}) {
  canRead(ctx);
  return withTenant(ctx.business.id, (tx) =>
    tx.serviceType.findMany({
      where: { businessId: ctx.business.id, ...(opts.includeArchived ? {} : { status: 'ACTIVE' }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  );
}

export async function createServiceType(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const data = parseOrThrow(serviceTypeSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const dup = await tx.serviceType.findFirst({ where: { businessId: ctx.business.id, status: 'ACTIVE', name: { equals: data.name, mode: 'insensitive' } } });
    if (dup) throw Errors.validation({ name: 'You already have a service type with this name.' });
    const row = await tx.serviceType.create({ data: { ...data, businessId: ctx.business.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.serviceTypeChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'service_type', resourceId: row.id, after: row });
    return row;
  });
}

export async function updateServiceType(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const typeId = parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(serviceTypeSchema.partial().extend({ archived: z.boolean().optional() }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.serviceType.findFirst({ where: { id: typeId, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Service type');
    const patch: Prisma.ServiceTypeUpdateInput = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.defaultDurationMin !== undefined) patch.defaultDurationMin = data.defaultDurationMin;
    if (data.archived !== undefined) patch.status = data.archived ? 'ARCHIVED' : 'ACTIVE';
    const after = await tx.serviceType.update({ where: { id: typeId }, data: patch }).catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.validation({ name: 'You already have a service type with this name.' });
      throw e;
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.serviceTypeChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'service_type', resourceId: typeId, before, after });
    return after;
  });
}

// ───────────────────────── bays ─────────────────────────

const baySchema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(60), locationId: uuidSchema.optional() });

export async function listBays(ctx: BusinessContext, opts: { includeArchived?: boolean } = {}) {
  canRead(ctx);
  return withTenant(ctx.business.id, (tx) =>
    tx.bay.findMany({ where: { businessId: ctx.business.id, ...(opts.includeArchived ? {} : { status: 'ACTIVE' }) }, orderBy: { name: 'asc' } }),
  );
}

export async function createBay(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const data = parseOrThrow(baySchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    if (data.locationId) await assertLocation(tx, ctx.business.id, data.locationId);
    const row = await tx.bay.create({ data: { name: data.name, locationId: data.locationId ?? null, businessId: ctx.business.id } }).catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.validation({ name: 'You already have a bay with this name.' });
      throw e;
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.bayChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'bay', resourceId: row.id, after: row });
    return row;
  });
}

export async function updateBay(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const bayId = parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(baySchema.partial().extend({ archived: z.boolean().optional() }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.bay.findFirst({ where: { id: bayId, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Bay');
    if (data.locationId) await assertLocation(tx, ctx.business.id, data.locationId);
    if (data.archived) {
      const upcoming = await tx.booking.count({ where: { businessId: ctx.business.id, bayId, startsAt: { gte: new Date() }, status: { notIn: ['CANCELLED', 'NO_SHOW', 'COMPLETED'] } } });
      if (upcoming > 0) throw Errors.conflict(`${upcoming} upcoming booking${upcoming === 1 ? ' is' : 's are'} assigned to this bay. Move them first.`);
    }
    const after = await tx.bay.update({
      where: { id: bayId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.locationId !== undefined ? { locationId: data.locationId } : {}),
        ...(data.archived !== undefined ? { status: data.archived ? 'ARCHIVED' : 'ACTIVE' } : {}),
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.bayChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'bay', resourceId: bayId, before, after });
    return after;
  });
}

// ───────────────────────── booking rules ─────────────────────────

export interface WorkshopRules {
  allowTechnicianOverlap: boolean;
  maxConcurrentJobs: number | null;
  requireCheckInSignature: boolean;
  requireRescheduleReason: boolean;
  notifyCustomerReschedule: boolean;
  notifyCustomerCancel: boolean;
  /** Minutes kept free between one appointment and the next for the same technician or bay. */
  bufferMinutes: number;
  /** An appointment must start at least this many minutes from now (a manager may knowingly override it). */
  minLeadMinutes: number;
  /** Cancelling an appointment that starts inside this many hours needs permission to manage the calendar. */
  cancelWindowHours: number;
  maxDailyBookings: number | null;
  allowWalkIns: boolean;
  waitingListEnabled: boolean;
}

export const DEFAULT_RULES: WorkshopRules = {
  allowTechnicianOverlap: false,
  maxConcurrentJobs: null,
  requireCheckInSignature: false,
  requireRescheduleReason: false,
  notifyCustomerReschedule: true,
  notifyCustomerCancel: true,
  bufferMinutes: 0,
  minLeadMinutes: 0,
  cancelWindowHours: 0,
  maxDailyBookings: null,
  allowWalkIns: true,
  waitingListEnabled: true,
};

/** The business's booking rules; a business that has never saved any uses the defaults above. */
export async function loadRules(tx: Tx, businessId: string): Promise<WorkshopRules> {
  const r = await tx.workshopSettings.findUnique({ where: { businessId } });
  return r ? { ...DEFAULT_RULES, ...r } : DEFAULT_RULES;
}

export async function getRules(ctx: BusinessContext): Promise<WorkshopRules> {
  canRead(ctx);
  return withTenant(ctx.business.id, (tx) => loadRules(tx, ctx.business.id));
}

const rulesSchema = z.object({
  allowTechnicianOverlap: z.boolean(),
  maxConcurrentJobs: z.union([z.null(), z.literal(''), z.coerce.number().int().min(1).max(500)]).transform((v) => (v === '' ? null : v)),
  requireCheckInSignature: z.boolean(),
  requireRescheduleReason: z.boolean(),
  notifyCustomerReschedule: z.boolean(),
  notifyCustomerCancel: z.boolean(),
  bufferMinutes: z.coerce.number().int().min(0).max(240),
  minLeadMinutes: z.coerce.number().int().min(0).max(10080),
  cancelWindowHours: z.coerce.number().int().min(0).max(720),
  maxDailyBookings: z.union([z.null(), z.literal(''), z.coerce.number().int().min(1).max(1000)]).transform((v) => (v === '' ? null : v)),
  allowWalkIns: z.boolean(),
  waitingListEnabled: z.boolean(),
}).partial();

export async function updateRules(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const data = parseOrThrow(rulesSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await loadRules(tx, ctx.business.id);
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    await tx.workshopSettings.upsert({
      where: { businessId: ctx.business.id },
      create: { businessId: ctx.business.id, ...clean },
      update: clean,
    });
    const after = await loadRules(tx, ctx.business.id);
    await recordAudit(tx, ctx.meta, { action: AuditActions.workshopSettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'workshop_settings', before, after });
    return after;
  });
}

// ───────────────────────── hours and technician schedules ─────────────────────────

const intervalInput = z.object({
  weekday: z.coerce.number().int().min(0).max(6),
  start: z.string().transform((s, c) => hhmmToMinutes(s) ?? (c.addIssue({ code: 'custom', message: 'Use a time like 08:00' }), 0)),
  end: z.string().transform((s, c) => hhmmToMinutes(s) ?? (c.addIssue({ code: 'custom', message: 'Use a time like 17:00' }), 0)),
});
const hoursSchema = z.object({ intervals: z.array(intervalInput).max(40) }).superRefine((v, ctx) => {
  const byDay = new Map<number, { start: number; end: number }[]>();
  v.intervals.forEach((i, idx) => {
    if (i.start >= i.end) ctx.addIssue({ code: 'custom', path: ['intervals', idx], message: 'The end must be after the start' });
    const list = byDay.get(i.weekday) ?? [];
    if (list.some((o) => i.start < o.end && o.start < i.end)) ctx.addIssue({ code: 'custom', path: ['intervals', idx], message: 'Hours on the same day cannot overlap' });
    list.push(i);
    byDay.set(i.weekday, list);
  });
});

export interface HourInterval { weekday: number; startMinute: number; endMinute: number }

export async function getWorkshopHours(ctx: BusinessContext): Promise<HourInterval[]> {
  canRead(ctx);
  return withTenant(ctx.business.id, async (tx) =>
    (await tx.workshopHours.findMany({ where: { businessId: ctx.business.id }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] })).map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
  );
}

/** Replace the workshop's whole weekly opening pattern. No rows at all means "no opening-hours restriction". */
export async function setWorkshopHours(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const { intervals } = parseOrThrow(hoursSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.workshopHours.findMany({ where: { businessId: ctx.business.id } });
    await tx.workshopHours.deleteMany({ where: { businessId: ctx.business.id } });
    if (intervals.length) await tx.workshopHours.createMany({ data: intervals.map((i) => ({ businessId: ctx.business.id, weekday: i.weekday, startMinute: i.start, endMinute: i.end })) });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.workshopHoursChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'workshop_hours',
      before: before.map((b) => ({ weekday: b.weekday, start: b.startMinute, end: b.endMinute })), after: intervals,
    });
    return getWorkshopHoursTx(tx, ctx.business.id);
  });
}

async function getWorkshopHoursTx(tx: Tx, businessId: string): Promise<HourInterval[]> {
  return (await tx.workshopHours.findMany({ where: { businessId }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] })).map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute }));
}

export async function getTechnicianSchedule(ctx: BusinessContext, membershipId: string) {
  canRead(ctx);
  const mid = parseOrThrow(uuidSchema, membershipId);
  return withTenant(ctx.business.id, async (tx) => {
    await assertActiveMember(tx, ctx.business.id, mid);
    const rows = await tx.technicianSchedule.findMany({ where: { businessId: ctx.business.id, membershipId: mid }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] });
    return rows.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute }));
  });
}

/** Replace one technician's weekly hours. No rows = they follow the workshop's hours. */
export async function setTechnicianSchedule(ctx: BusinessContext, membershipId: string, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const mid = parseOrThrow(uuidSchema, membershipId);
  const { intervals } = parseOrThrow(hoursSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await assertActiveMember(tx, ctx.business.id, mid);
    await tx.technicianSchedule.deleteMany({ where: { businessId: ctx.business.id, membershipId: mid } });
    if (intervals.length) await tx.technicianSchedule.createMany({ data: intervals.map((i) => ({ businessId: ctx.business.id, membershipId: mid, weekday: i.weekday, startMinute: i.start, endMinute: i.end })) });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.technicianScheduleChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: mid, after: intervals,
    });
  });
}

const timeOffSchema = z.object({
  membershipId: uuidSchema,
  kind: z.enum(['LEAVE', 'DAY_OFF', 'SICK', 'OTHER']).default('LEAVE'),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  reason: optionalText(200),
}).refine((v) => v.endsAt > v.startsAt, { path: ['endsAt'], message: 'The end must be after the start' });

export async function listTimeOff(ctx: BusinessContext, query: { membershipId?: string; from?: Date } = {}) {
  canRead(ctx);
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.technicianTimeOff.findMany({
      where: { businessId: ctx.business.id, ...(query.membershipId ? { membershipId: query.membershipId } : {}), endsAt: { gte: query.from ?? new Date() } },
      orderBy: { startsAt: 'asc' }, take: 200,
    });
    const names = await memberNames(tx, ctx.business.id, rows.map((r) => r.membershipId));
    return rows.map((r) => ({ ...r, technician: names.get(r.membershipId) ?? null }));
  });
}

export async function addTimeOff(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'booking.manage');
  const data = parseOrThrow(timeOffSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await assertActiveMember(tx, ctx.business.id, data.membershipId, 'membershipId');
    const row = await tx.technicianTimeOff.create({ data: { ...data, businessId: ctx.business.id, createdById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.technicianTimeOffChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'technician_time_off', resourceId: row.id, after: row });
    return row;
  });
}

export async function removeTimeOff(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'booking.manage');
  const rowId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const row = await tx.technicianTimeOff.findFirst({ where: { id: rowId, businessId: ctx.business.id } });
    if (!row) throw Errors.notFound('Time off');
    await tx.technicianTimeOff.delete({ where: { id: rowId } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.technicianTimeOffChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'technician_time_off', resourceId: rowId, before: row });
  });
}

/** Everything a booking or job form needs in one request. */
export async function getWorkshopLookups(ctx: BusinessContext) {
  canRead(ctx);
  return withTenant(ctx.business.id, async (tx) => ({
    serviceTypes: await tx.serviceType.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    bays: await tx.bay.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: { name: 'asc' } }),
    technicians: await listTechnicians(tx, ctx.business.id),
    locations: await tx.location.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true, isDefault: true } }),
    rules: await loadRules(tx, ctx.business.id),
  }));
}

/** Defaults every new business starts with (all editable). Called inside the business-creation transaction. */
export async function seedWorkshopDefaults(tx: Tx, businessId: string): Promise<void> {
  await tx.serviceType.createMany({
    data: [
      { name: 'Minor service', defaultDurationMin: 120 }, { name: 'Major service', defaultDurationMin: 240 }, { name: 'Diagnostic', defaultDurationMin: 60 },
      { name: 'Brake service', defaultDurationMin: 120 }, { name: 'Tyres and alignment', defaultDurationMin: 60 },
    ].map((s, i) => ({ ...s, businessId, sortOrder: i + 1 })),
  });
  await tx.workshopHours.createMany({ data: [1, 2, 3, 4, 5].map((weekday) => ({ businessId, weekday, startMinute: 480, endMinute: 1020 })) });
  await tx.workshopSettings.create({ data: { businessId } });
  // Money settings start with sensible defaults (numbering, terms, methods, reminder schedule); the owner adjusts them later.
  await tx.financeSettings.create({ data: { businessId, enabledMethods: ['CARD', 'EFT', 'CASH', 'OTHER'], reminderOffsets: [-3, 0, 7] } });
  // Stock, purchasing and numbering start with defaults too (unique SKUs and barcodes, no negative stock, last-cost valuation).
  await tx.inventorySettings.create({ data: { businessId } });
}

/** Display names for membership ids, for screens that show who a record refers to. */
export async function resolveMemberNames(ctx: BusinessContext, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  canRead(ctx);
  return withTenant(ctx.business.id, (tx) => memberNames(tx, ctx.business.id, ids));
}
