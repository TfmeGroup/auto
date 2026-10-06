/**
 * Business-local time helpers. All instants are stored in UTC; availability rules ("open 08:00-17:00 on
 * weekdays") are expressed in the business's own timezone, so converting between the two happens here
 * and nowhere else. Built on Intl only: no date library.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 = Sunday
  minute: number; // minutes since local midnight
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function localParts(at: Date, timeZone: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of fmt(timeZone).formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    weekday: WEEKDAYS[p.weekday!] ?? 0,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** The UTC instant at which the wall clock in `timeZone` reads y-m-d and `minute` minutes past midnight. */
export function zonedToUtc(year: number, month: number, day: number, minute: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minute);
  const offsetAt = (t: number) => {
    const l = localParts(new Date(t), timeZone);
    const asUtc = Date.UTC(l.year, l.month - 1, l.day, 0, l.minute);
    return asUtc - Math.floor(t / 60_000) * 60_000;
  };
  let guess = naive - offsetAt(naive);
  guess = naive - offsetAt(guess);
  return new Date(guess);
}

export const isoDate = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function parseIsoDate(s: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
}

/** [start, end) of a local calendar day, as UTC instants. */
export function dayRange(isoDay: string, timeZone: string): { start: Date; end: Date } {
  const p = parseIsoDate(isoDay);
  if (!p) throw new Error(`invalid date ${isoDay}`);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return {
    start: zonedToUtc(p.year, p.month, p.day, 0, timeZone),
    end: zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, timeZone),
  };
}

/** Add whole calendar days to an ISO date (no timezone involved). */
export function addDays(isoDay: string, days: number): string {
  const p = parseIsoDate(isoDay)!;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Add whole calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(isoDay: string, months: number): string {
  const p = parseIsoDate(isoDay)!;
  const total = p.year * 12 + (p.month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return isoDate(y, m, Math.min(p.day, last));
}

export const todayIso = (timeZone: string, now = new Date()) => {
  const l = localParts(now, timeZone);
  return isoDate(l.year, l.month, l.day);
};

/** Monday-based week start of an ISO date. */
export function weekStart(isoDay: string): string {
  const p = parseIsoDate(isoDay)!;
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return addDays(isoDay, -((wd + 6) % 7));
}

export const weekdayOf = (isoDay: string) => {
  const p = parseIsoDate(isoDay)!;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
};

export const minutesToHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) <= 24 && Number(m[2]) < 60 && v <= 1440 ? v : null;
}
