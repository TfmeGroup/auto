import { describe, expect, it } from 'vitest';
import { FORWARD, JOB_STATUSES, decideTransition, nextStatuses, type JobStatus } from '@/server/jobcards/transitions';
import { evaluateSlot, peakConcurrency, type AvailabilityData } from '@/server/bookings/availability';
import { DEFAULT_RULES } from '@/server/workshop/service';
import { recurrenceDates } from '@/server/bookings/extras';
import { intervalStatus } from '@/server/vehicles/insights';
import { normalizeRegistration } from '@/server/vehicles/service';
import { addDays, addMonths, dayRange, localParts, weekStart, zonedToUtc } from '@/lib/tz';
import { minutesAmount } from '@/lib/money';

const TZ = 'Africa/Johannesburg';

describe('job status transitions (pure rules)', () => {
  const ok = (from: JobStatus, to: JobStatus, heldFrom?: JobStatus) => decideTransition({ from, to, heldFrom }).allowed;

  it('allows exactly the workflow in the specification', () => {
    expect(ok('BOOKED', 'CHECKED_IN')).toBe(true);
    expect(ok('CHECKED_IN', 'INSPECTION')).toBe(true);
    expect(ok('INSPECTION', 'DIAGNOSIS')).toBe(true);
    expect(ok('DIAGNOSIS', 'AWAITING_APPROVAL')).toBe(true);
    expect(ok('AWAITING_APPROVAL', 'APPROVED')).toBe(true);
    expect(ok('APPROVED', 'AWAITING_PARTS')).toBe(true);
    expect(ok('APPROVED', 'IN_PROGRESS')).toBe(true);
    expect(ok('IN_PROGRESS', 'QUALITY_CHECK')).toBe(true);
    expect(ok('READY_FOR_COLLECTION', 'COMPLETED')).toBe(true);
  });

  it('refuses every skipped or backwards step', () => {
    expect(ok('BOOKED', 'INSPECTION')).toBe(false);
    expect(ok('CHECKED_IN', 'APPROVED')).toBe(false);
    expect(ok('DIAGNOSIS', 'IN_PROGRESS')).toBe(false);
    expect(ok('IN_PROGRESS', 'COMPLETED')).toBe(false);
    expect(ok('APPROVED', 'DIAGNOSIS')).toBe(false);
    expect(ok('READY_FOR_COLLECTION', 'IN_PROGRESS')).toBe(false);
  });

  it('every state pair outside the workflow, hold and cancel rules is rejected', () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const d = decideTransition({ from, to, heldFrom: 'IN_PROGRESS' });
        let expected: boolean;
        if (from === to || from === 'COMPLETED' || from === 'CANCELLED') expected = false;
        else if (to === 'CANCELLED') expected = true;
        else if (from === 'ON_HOLD') expected = to === 'IN_PROGRESS';
        else if (to === 'ON_HOLD') expected = from !== 'BOOKED';
        else expected = FORWARD[from].includes(to) && from !== 'QUALITY_CHECK';
        expect(d.allowed, `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('quality check can only be left through its result', () => {
    expect(decideTransition({ from: 'QUALITY_CHECK', to: 'READY_FOR_COLLECTION' })).toMatchObject({ allowed: false, kind: 'quality_gated' });
    expect(decideTransition({ from: 'QUALITY_CHECK', to: 'IN_PROGRESS' })).toMatchObject({ allowed: false, kind: 'quality_gated' });
  });

  it('a held job resumes only where it was, and closed jobs are final', () => {
    expect(ok('ON_HOLD', 'IN_PROGRESS', 'IN_PROGRESS')).toBe(true);
    expect(ok('ON_HOLD', 'APPROVED', 'IN_PROGRESS')).toBe(false);
    expect(ok('COMPLETED', 'IN_PROGRESS')).toBe(false);
    expect(ok('CANCELLED', 'CHECKED_IN')).toBe(false);
    expect(ok('BOOKED', 'ON_HOLD')).toBe(false);
  });

  it('an explicit override permits any other status, but never a no-op', () => {
    expect(decideTransition({ from: 'COMPLETED', to: 'IN_PROGRESS', override: true })).toMatchObject({ allowed: true, kind: 'override' });
    expect(decideTransition({ from: 'COMPLETED', to: 'COMPLETED', override: true }).allowed).toBe(false);
  });

  it('nextStatuses offers cancel always, hold only once arrived', () => {
    expect(nextStatuses('BOOKED').map((s) => s.to)).toEqual(['CHECKED_IN', 'CANCELLED']);
    expect(nextStatuses('IN_PROGRESS').map((s) => s.to)).toContain('ON_HOLD');
    expect(nextStatuses('QUALITY_CHECK').map((s) => s.to)).toEqual(['ON_HOLD', 'CANCELLED']);
    expect(nextStatuses('COMPLETED')).toEqual([]);
  });
});

describe('time zone helpers', () => {
  it('converts business-local wall time to UTC and back (UTC+2, no DST)', () => {
    const d = zonedToUtc(2026, 11, 3, 9 * 60 + 30, TZ);
    expect(d.toISOString()).toBe('2026-11-03T07:30:00.000Z');
    expect(localParts(d, TZ)).toMatchObject({ year: 2026, month: 11, day: 3, minute: 570, weekday: 2 });
  });
  it('a local day is [00:00, next 00:00) in UTC', () => {
    const { start, end } = dayRange('2026-11-03', TZ);
    expect(start.toISOString()).toBe('2026-11-02T22:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });
  it('date arithmetic clamps month ends and finds Monday', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
  });
});

describe('availability rules (pure)', () => {
  const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1020 }));
  const baseRules = { ...DEFAULT_RULES };
  const base = (over: Partial<AvailabilityData> = {}): AvailabilityData => ({
    timezone: TZ, workshopHours: weekdays, technicianSchedules: new Map(), timeOff: [], bookings: [], rules: baseRules, bayCount: 0, dayCounts: new Map(), ...over,
  });
  const slot = (date: [number, number, number], h: number, m: number, mins: number, extra: Record<string, unknown> = {}) => {
    const startsAt = zonedToUtc(date[0], date[1], date[2], h * 60 + m, TZ);
    return { startsAt, endsAt: new Date(startsAt.getTime() + mins * 60_000), now: new Date('2026-01-01T00:00:00Z'), ...extra };
  };
  const TUE: [number, number, number] = [2026, 11, 3];
  const SAT: [number, number, number] = [2026, 11, 7];
  const codes = (d: AvailabilityData, r: ReturnType<typeof slot>) => evaluateSlot(d, r).map((c) => c.code);

  it('accepts a slot inside opening hours', () => expect(codes(base(), slot(TUE, 9, 0, 120))).toEqual([]));
  it('rejects the past', () => expect(codes(base(), { ...slot(TUE, 9, 0, 60), now: new Date('2027-01-01T00:00:00Z') })).toContain('IN_PAST'));
  it('rejects a closed day and a slot that runs past closing', () => {
    expect(codes(base(), slot(SAT, 9, 0, 60))).toEqual(['OUTSIDE_HOURS']);
    expect(codes(base(), slot(TUE, 16, 0, 120))).toEqual(['OUTSIDE_HOURS']);
    expect(codes(base(), slot(TUE, 7, 0, 60))).toEqual(['OUTSIDE_HOURS']);
    expect(codes(base(), slot(TUE, 16, 0, 60))).toEqual([]);
  });
  it('no opening hours configured = no hours restriction', () => expect(codes(base({ workshopHours: [] }), slot(SAT, 3, 0, 60))).toEqual([]));

  it("honours a technician's own hours and leave", () => {
    const tech = 't1';
    const d = base({ technicianSchedules: new Map([[tech, [{ weekday: 2, startMinute: 600, endMinute: 780 }]]]) });
    expect(codes(d, slot(TUE, 9, 0, 60, { technicianMembershipId: tech }))).toEqual(['TECHNICIAN_OFF']);
    expect(codes(d, slot(TUE, 10, 0, 60, { technicianMembershipId: tech }))).toEqual([]);
    const leave = base({ timeOff: [{ membershipId: tech, startsAt: zonedToUtc(2026, 11, 3, 0, TZ), endsAt: zonedToUtc(2026, 11, 4, 0, TZ) }] });
    expect(codes(leave, slot(TUE, 9, 0, 60, { technicianMembershipId: tech }))).toEqual(['TECHNICIAN_OFF']);
  });

  it('prevents double-booking a technician unless the business allows it', () => {
    const s = slot(TUE, 9, 0, 120);
    const existing = { id: 'b1', bookingNumber: 'BKG-1', startsAt: s.startsAt, endsAt: s.endsAt, technicianMembershipId: 't1', bayId: null };
    const d = base({ bookings: [existing] });
    expect(codes(d, slot(TUE, 10, 0, 60, { technicianMembershipId: 't1' }))).toEqual(['TECHNICIAN_BUSY']);
    expect(codes(d, slot(TUE, 11, 0, 60, { technicianMembershipId: 't1' }))).toEqual([]);
    expect(codes(d, slot(TUE, 10, 0, 60, { technicianMembershipId: 't2' }))).toEqual([]);
    expect(codes(d, slot(TUE, 10, 0, 60, { technicianMembershipId: 't1', excludeBookingId: 'b1' }))).toEqual([]);
    const lax = base({ bookings: [existing], rules: { ...baseRules, allowTechnicianOverlap: true } });
    expect(codes(lax, slot(TUE, 10, 0, 60, { technicianMembershipId: 't1' }))).toEqual([]);
  });

  it('a bay holds one appointment at a time', () => {
    const s = slot(TUE, 9, 0, 60);
    const d = base({ bookings: [{ id: 'b1', bookingNumber: 'BKG-1', startsAt: s.startsAt, endsAt: s.endsAt, technicianMembershipId: null, bayId: 'bay1' }], bayCount: 2 });
    expect(codes(d, slot(TUE, 9, 30, 60, { bayId: 'bay1' }))).toEqual(['BAY_BUSY']);
    expect(codes(d, slot(TUE, 9, 30, 60, { bayId: 'bay2' }))).toEqual([]);
  });

  it('capacity: configured maximum, else the number of bays', () => {
    const s = slot(TUE, 9, 0, 60);
    const mk = (id: string) => ({ id, bookingNumber: id, startsAt: s.startsAt, endsAt: s.endsAt, technicianMembershipId: null, bayId: null });
    const two = base({ bookings: [mk('a'), mk('b')], rules: { ...baseRules, maxConcurrentJobs: 2 } });
    expect(codes(two, slot(TUE, 9, 0, 60))).toEqual(['CAPACITY_FULL']);
    expect(codes(two, slot(TUE, 10, 0, 60))).toEqual([]);
    expect(codes(base({ bookings: [mk('a'), mk('b')], bayCount: 2 }), slot(TUE, 9, 30, 30))).toEqual(['CAPACITY_FULL']);
    expect(codes(base({ bookings: [mk('a'), mk('b')] }), slot(TUE, 9, 0, 60))).toEqual([]);
  });

  it('peak concurrency counts overlap at one moment, not the number of overlapping bookings', () => {
    const at = (h: number, mins: number) => { const s = slot(TUE, h, 0, mins); return { startsAt: s.startsAt, endsAt: s.endsAt }; };
    const win = at(9, 120);
    expect(peakConcurrency([at(9, 60), at(10, 60)], win.startsAt, win.endsAt)).toBe(1);
    expect(peakConcurrency([at(9, 90), at(10, 60)], win.startsAt, win.endsAt)).toBe(2);
  });
});

describe('recurring series dates', () => {
  it('weekly and fortnightly by count', () => {
    expect(recurrenceDates('2026-11-02', 'WEEKLY', 1, undefined, 3)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(recurrenceDates('2026-11-02', 'WEEKLY', 2, undefined, 3)).toEqual(['2026-11-02', '2026-11-16', '2026-11-30']);
  });
  it('monthly keeps the anchor day without drifting', () => {
    expect(recurrenceDates('2026-01-31', 'MONTHLY', 1, undefined, 4)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });
  it('stops at the end date, and never exceeds the hard cap', () => {
    expect(recurrenceDates('2026-11-02', 'WEEKLY', 1, '2026-11-16')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(recurrenceDates('2026-01-01', 'WEEKLY', 1, '2040-01-01').length).toBe(104);
  });
});

describe('maintenance intervals', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  it('is due by whichever limit comes first', () => {
    const i = { everyKm: 10_000, everyMonths: 12, lastServiceAt: new Date('2026-01-01T00:00:00Z'), lastServiceKm: 50_000 };
    expect(intervalStatus(i, 55_000, now)).toMatchObject({ overdue: false, nextDueKm: 60_000 });
    expect(intervalStatus(i, 60_000, now)).toMatchObject({ overdue: true, overdueByKm: true, overdueByDate: false });
    expect(intervalStatus(i, 55_000, new Date('2027-02-01T00:00:00Z'))).toMatchObject({ overdue: true, overdueByDate: true });
  });
  it('needs a baseline before anything can be overdue', () => {
    expect(intervalStatus({ everyKm: 10_000, everyMonths: null, lastServiceAt: null, lastServiceKm: null }, 999_999, now)).toMatchObject({ overdue: false, needsBaseline: true });
  });
});

describe('vehicle identifiers and labour arithmetic', () => {
  it('normalises registrations for uniqueness and search', () => {
    expect(normalizeRegistration('ca 123-456')).toBe('CA123456');
    expect(normalizeRegistration('CA123456')).toBe('CA123456');
  });
  it('labour = minutes x hourly rate, rounded to the cent, integers only', () => {
    expect(minutesAmount(20, 45_000)).toBe(15_000);
    expect(minutesAmount(90, 45_000)).toBe(67_500);
    expect(minutesAmount(7, 45_000)).toBe(5_250);
    expect(minutesAmount(1, 100)).toBe(2);
  });
});

describe('booking rules set in Settings (pure)', () => {
  const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1020 }));
  const make = (rules: Partial<typeof DEFAULT_RULES>, over: Partial<AvailabilityData> = {}): AvailabilityData => ({
    timezone: TZ, workshopHours: weekdays, technicianSchedules: new Map(), timeOff: [], bookings: [], rules: { ...DEFAULT_RULES, ...rules }, bayCount: 0, dayCounts: new Map(), ...over,
  });
  const at = (h: number, m: number, mins: number, extra: Record<string, unknown> = {}) => {
    const startsAt = zonedToUtc(2026, 11, 3, h * 60 + m, TZ);
    return { startsAt, endsAt: new Date(startsAt.getTime() + mins * 60_000), now: new Date('2026-11-01T00:00:00Z'), ...extra };
  };
  const codes = (d: AvailabilityData, r: ReturnType<typeof at> & { isWalkIn?: boolean }) => evaluateSlot(d, r).map((c) => c.code);
  const booked = (h: number, mins: number, over: Record<string, unknown> = {}) => {
    const s = at(h, 0, mins);
    return { id: 'b1', bookingNumber: 'BKG-1', startsAt: s.startsAt, endsAt: s.endsAt, technicianMembershipId: 't1', bayId: 'bay1', ...over };
  };

  it('a buffer keeps a gap between one appointment and the next for the same technician or bay', () => {
    const d = make({ bufferMinutes: 30 }, { bookings: [booked(9, 120)] }); // 09:00-11:00
    expect(codes(d, at(11, 15, 60, { technicianMembershipId: 't1' }))).toEqual(['TECHNICIAN_BUSY']);
    expect(codes(d, at(11, 15, 60, { bayId: 'bay1' }))).toEqual(['BAY_BUSY']);
    expect(codes(d, at(11, 30, 60, { technicianMembershipId: 't1' }))).toEqual([]);
    expect(codes(d, at(8, 15, 30, { technicianMembershipId: 't1' }))).toEqual(['TECHNICIAN_BUSY']); // finishing 15 min before is inside the buffer
    expect(codes(d, at(8, 0, 30, { technicianMembershipId: 't1' }))).toEqual([]); // a full 30-minute gap is enough
    expect(codes(d, at(11, 15, 60, { technicianMembershipId: 't2' }))).toEqual([]); // another technician is unaffected
    expect(codes(make({ bufferMinutes: 0 }, { bookings: [booked(9, 120)] }), at(11, 0, 60, { technicianMembershipId: 't1' }))).toEqual([]);
  });

  it('a minimum lead time is a soft rule that walk-ins are exempt from', () => {
    const d = make({ minLeadMinutes: 120 });
    const r = at(9, 0, 60, { now: new Date(zonedToUtc(2026, 11, 3, 8 * 60, TZ)) }); // one hour before the appointment
    const c = evaluateSlot(d, r);
    expect(c.map((x) => x.code)).toEqual(['LEAD_TIME']);
    expect(c[0]!.soft).toBe(true);
    expect(codes(d, { ...r, isWalkIn: true })).toEqual([]);
    expect(codes(d, at(9, 0, 60, { now: new Date(zonedToUtc(2026, 11, 3, 6 * 60, TZ)) }))).toEqual([]); // three hours ahead is fine
  });

  it('a daily limit counts the bookings already on that local day, and a booking being moved does not count against itself', () => {
    const d = make({ maxDailyBookings: 2 }, { dayCounts: new Map([['2026-11-03', 2]]) });
    expect(codes(d, at(9, 0, 60))).toEqual(['DAILY_FULL']);
    expect(codes(make({ maxDailyBookings: 3 }, { dayCounts: new Map([['2026-11-03', 2]]) }), at(9, 0, 60))).toEqual([]);
    const moving = make({ maxDailyBookings: 2 }, { dayCounts: new Map([['2026-11-03', 2]]), bookings: [booked(14, 60, { id: 'mine' })] });
    expect(codes(moving, at(9, 0, 60, { excludeBookingId: 'mine' }))).toEqual([]);
  });

  it('walk-ins can be switched off', () => {
    expect(codes(make({ allowWalkIns: false }), at(9, 0, 60, { isWalkIn: true }))).toEqual(['WALK_INS_OFF']);
    expect(codes(make({ allowWalkIns: true }), at(9, 0, 60, { isWalkIn: true }))).toEqual([]);
    expect(codes(make({ allowWalkIns: false }), at(9, 0, 60))).toEqual([]);
  });
});
