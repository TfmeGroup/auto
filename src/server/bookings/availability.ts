import { seq, type Tx } from '@/server/db/client';
import { localParts, minutesToHhmm } from '@/lib/tz';
import { loadRules, type WorkshopRules } from '@/server/workshop/service';

/**
 * Booking availability. The rules are evaluated by a PURE function over preloaded data (so they are
 * unit-testable and the same code answers "can I book this?" and "which times are free?"):
 *
 *   OUTSIDE_HOURS     the appointment must start inside the workshop's opening hours and finish the same day
 *   TECHNICIAN_OFF    the technician must be working (their own hours, else the workshop's) and not on leave
 *   TECHNICIAN_BUSY   a technician cannot hold two overlapping appointments (unless the business allows it)
 *   BAY_BUSY          a bay holds one appointment at a time (also enforced by an exclusion constraint)
 *   CAPACITY_FULL     concurrent appointments may not exceed the configured maximum, or the number of bays
 *
 * Hours and leave are "soft": a person with booking.manage may knowingly book outside them. The rest are
 * never overridden.
 */

export type ConflictCode = 'IN_PAST' | 'OUTSIDE_HOURS' | 'TECHNICIAN_OFF' | 'TECHNICIAN_BUSY' | 'BAY_BUSY' | 'CAPACITY_FULL' | 'LEAD_TIME' | 'DAILY_FULL' | 'WALK_INS_OFF';

export interface Conflict {
  code: ConflictCode;
  message: string;
  /** Soft conflicts may be overridden by someone allowed to manage the calendar. */
  soft: boolean;
  bookingId?: string;
}

interface Interval { weekday: number; startMinute: number; endMinute: number }

export interface LiveBooking {
  id: string;
  bookingNumber: string;
  startsAt: Date;
  endsAt: Date;
  technicianMembershipId: string | null;
  bayId: string | null;
}

export interface AvailabilityData {
  timezone: string;
  workshopHours: Interval[];
  technicianSchedules: Map<string, Interval[]>;
  timeOff: { membershipId: string; startsAt: Date; endsAt: Date }[];
  bookings: LiveBooking[];
  rules: WorkshopRules;
  bayCount: number;
  /** Live appointments per local calendar day (for the daily limit). */
  dayCounts: Map<string, number>;
}

export interface SlotRequest {
  startsAt: Date;
  endsAt: Date;
  technicianMembershipId?: string | null;
  bayId?: string | null;
  excludeBookingId?: string;
  isWalkIn?: boolean;
  now?: Date;
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

/** Is [start,end) (local minutes on one day) covered at its start by an interval, and ending before that day's last close? */
function withinDay(intervals: Interval[], weekday: number, startMin: number, endMin: number): boolean {
  const day = intervals.filter((i) => i.weekday === weekday);
  if (day.length === 0) return false;
  const startsInside = day.some((i) => startMin >= i.startMinute && startMin < i.endMinute);
  const lastClose = Math.max(...day.map((i) => i.endMinute));
  return startsInside && endMin <= lastClose;
}

/** Highest number of appointments running at the same moment within [start,end). */
export function peakConcurrency(others: { startsAt: Date; endsAt: Date }[], start: Date, end: Date): number {
  const marks = new Set<number>([start.getTime()]);
  for (const o of others) if (o.startsAt > start && o.startsAt < end) marks.add(o.startsAt.getTime());
  let peak = 0;
  for (const t of marks) {
    const n = others.filter((o) => o.startsAt.getTime() <= t && t < o.endsAt.getTime()).length;
    peak = Math.max(peak, n);
  }
  return peak;
}

export function evaluateSlot(data: AvailabilityData, req: SlotRequest): Conflict[] {
  const out: Conflict[] = [];
  const now = req.now ?? new Date();
  if (req.startsAt.getTime() < now.getTime() - 5 * 60_000) {
    out.push({ code: 'IN_PAST', soft: false, message: 'That time has already passed.' });
  }

  const rules = data.rules;
  if (req.isWalkIn && !rules.allowWalkIns) out.push({ code: 'WALK_INS_OFF', soft: false, message: 'Walk-ins are switched off for this workshop.' });
  if (!req.isWalkIn && rules.minLeadMinutes > 0 && req.startsAt.getTime() >= now.getTime() - 5 * 60_000 && req.startsAt.getTime() < now.getTime() + rules.minLeadMinutes * 60_000) {
    const h = rules.minLeadMinutes;
    out.push({ code: 'LEAD_TIME', soft: true, message: `Bookings need at least ${h >= 120 && h % 60 === 0 ? `${h / 60} hours` : `${h} minutes`} notice.` });
  }

  const s = localParts(req.startsAt, data.timezone);
  const e = localParts(new Date(req.endsAt.getTime() - 1), data.timezone);
  const sameDay = s.year === e.year && s.month === e.month && s.day === e.day;
  const endMin = sameDay ? e.minute + 1 : 24 * 60 + 1;

  if (data.workshopHours.length > 0 && !(sameDay && withinDay(data.workshopHours, s.weekday, s.minute, endMin))) {
    const day = data.workshopHours.filter((i) => i.weekday === s.weekday);
    out.push({
      code: 'OUTSIDE_HOURS', soft: true,
      message: day.length === 0 ? 'The workshop is closed on that day.' : `The workshop is open ${day.map((i) => `${minutesToHhmm(i.startMinute)}–${minutesToHhmm(i.endMinute)}`).join(', ')} that day, and the appointment must finish by closing time.`,
    });
  }

  const tech = req.technicianMembershipId;
  if (tech) {
    const own = data.technicianSchedules.get(tech);
    if (own && own.length > 0 && !(sameDay && withinDay(own, s.weekday, s.minute, endMin))) {
      out.push({ code: 'TECHNICIAN_OFF', soft: true, message: 'That technician is not working at that time.' });
    }
    if (data.timeOff.some((t) => t.membershipId === tech && overlaps(req.startsAt, req.endsAt, t.startsAt, t.endsAt))) {
      out.push({ code: 'TECHNICIAN_OFF', soft: true, message: 'That technician is on leave at that time.' });
    }
  }

  const others = data.bookings.filter((b) => b.id !== req.excludeBookingId && overlaps(req.startsAt, req.endsAt, b.startsAt, b.endsAt));
  // The buffer widens only the technician and bay checks (a gap between jobs); it does not change how many run at once.
  const gap = rules.bufferMinutes * 60_000;
  const near = gap > 0 ? data.bookings.filter((b) => b.id !== req.excludeBookingId && overlaps(new Date(req.startsAt.getTime() - gap), new Date(req.endsAt.getTime() + gap), b.startsAt, b.endsAt)) : others;
  const bufferNote = gap > 0 ? ` (a ${rules.bufferMinutes}-minute gap is kept between appointments)` : '';

  if (tech && !rules.allowTechnicianOverlap) {
    const clash = near.find((b) => b.technicianMembershipId === tech);
    if (clash) out.push({ code: 'TECHNICIAN_BUSY', soft: false, bookingId: clash.id, message: `That technician already has booking ${clash.bookingNumber} at that time${bufferNote}.` });
  }
  if (req.bayId) {
    const clash = near.find((b) => b.bayId === req.bayId);
    if (clash) out.push({ code: 'BAY_BUSY', soft: false, bookingId: clash.id, message: `That bay is already used by booking ${clash.bookingNumber} at that time${bufferNote}.` });
  }
  if (rules.maxDailyBookings !== null) {
    const day = `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;
    let count = data.dayCounts.get(day) ?? 0;
    const moved = req.excludeBookingId ? data.bookings.find((b) => b.id === req.excludeBookingId) : undefined;
    if (moved) {
      const m = localParts(moved.startsAt, data.timezone);
      if (`${m.year}-${String(m.month).padStart(2, '0')}-${String(m.day).padStart(2, '0')}` === day) count -= 1;
    }
    if (count >= rules.maxDailyBookings) out.push({ code: 'DAILY_FULL', soft: false, message: `The workshop is limited to ${rules.maxDailyBookings} bookings a day and that day is full.` });
  }

  const limit = data.rules.maxConcurrentJobs ?? (data.bayCount > 0 ? data.bayCount : null);
  if (limit !== null && peakConcurrency(others, req.startsAt, req.endsAt) >= limit) {
    out.push({
      code: 'CAPACITY_FULL', soft: false,
      message: data.rules.maxConcurrentJobs !== null ? `The workshop is at its limit of ${limit} jobs at once at that time.` : `All ${limit} bays are taken at that time.`,
    });
  }
  return out;
}

/** Load everything evaluateSlot needs for a time window (one query per source, however many slots are checked). */
export async function loadAvailabilityData(tx: Tx, businessId: string, timezone: string, from: Date, to: Date): Promise<AvailabilityData> {
  const rules = await loadRules(tx, businessId);
  const [hours, schedules, timeOff, bookings, bayCount, perDay] = await seq([
    tx.workshopHours.findMany({ where: { businessId } }),
    tx.technicianSchedule.findMany({ where: { businessId } }),
    tx.technicianTimeOff.findMany({ where: { businessId, endsAt: { gt: from }, startsAt: { lt: to } } }),
    tx.booking.findMany({
      where: { businessId, status: { notIn: ['CANCELLED', 'NO_SHOW'] }, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { id: true, bookingNumber: true, startsAt: true, endsAt: true, technicianMembershipId: true, bayId: true },
    }),
    tx.bay.count({ where: { businessId, status: 'ACTIVE' } }),
    rules.maxDailyBookings === null
      ? Promise.resolve([] as { d: string; n: number }[])
      : tx.$queryRaw<{ d: string; n: number }[]>`
          SELECT ((starts_at AT TIME ZONE ${timezone})::date)::text AS d, COUNT(*)::int AS n FROM bookings
           WHERE business_id = ${businessId}::uuid AND status NOT IN ('CANCELLED', 'NO_SHOW') AND starts_at >= ${from} AND starts_at < ${to} GROUP BY 1`,
  ]);
  const technicianSchedules = new Map<string, Interval[]>();
  for (const s of schedules) {
    const list = technicianSchedules.get(s.membershipId) ?? [];
    list.push({ weekday: s.weekday, startMinute: s.startMinute, endMinute: s.endMinute });
    technicianSchedules.set(s.membershipId, list);
  }
  return {
    timezone,
    workshopHours: hours.map((h) => ({ weekday: h.weekday, startMinute: h.startMinute, endMinute: h.endMinute })),
    technicianSchedules, timeOff, bookings, rules, bayCount, dayCounts: new Map(perDay.map((r) => [r.d, r.n])),
  };
}

/**
 * Serialise booking changes for one business. Held until the transaction ends, so two people booking
 * (or moving) appointments at the same moment are checked one after the other against each other's result.
 */
export async function lockBookingCalendar(tx: Tx, businessId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar:${businessId}`}, 0))`;
}
