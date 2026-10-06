import { Errors } from '@/lib/errors';
import { addDays, addMonths, dayRange, parseIsoDate, todayIso, weekStart } from '@/lib/tz';
import type { Range } from './types';

/** Date presets, all computed on the business's own calendar (never UTC). `to` is inclusive. */
export const PRESETS = ['TODAY', 'YESTERDAY', 'THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'LAST_QUARTER', 'THIS_YEAR', 'LAST_YEAR', 'CUSTOM'] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_LABEL: Record<Preset, string> = {
  TODAY: 'Today', YESTERDAY: 'Yesterday', THIS_WEEK: 'This week', LAST_WEEK: 'Last week', THIS_MONTH: 'This month', LAST_MONTH: 'Last month',
  THIS_QUARTER: 'This quarter', LAST_QUARTER: 'Last quarter', THIS_YEAR: 'This year', LAST_YEAR: 'Last year', CUSTOM: 'Custom range',
};

export const isPreset = (v: string): v is Preset => (PRESETS as readonly string[]).includes(v);

const MAX_DAYS = 800;

/** The inclusive [from, to] calendar days of a preset, relative to `today` (a local ISO date). */
export function presetDays(preset: Exclude<Preset, 'CUSTOM'>, today: string): { from: string; to: string } {
  const p = parseIsoDate(today)!;
  const monthStart = `${today.slice(0, 7)}-01`;
  const quarterStartMonth = Math.floor((p.month - 1) / 3) * 3 + 1;
  const quarterStart = `${p.year}-${String(quarterStartMonth).padStart(2, '0')}-01`;
  switch (preset) {
    case 'TODAY': return { from: today, to: today };
    case 'YESTERDAY': { const d = addDays(today, -1); return { from: d, to: d }; }
    case 'THIS_WEEK': return { from: weekStart(today), to: addDays(weekStart(today), 6) };
    case 'LAST_WEEK': { const s = addDays(weekStart(today), -7); return { from: s, to: addDays(s, 6) }; }
    case 'THIS_MONTH': return { from: monthStart, to: addDays(addMonths(monthStart, 1), -1) };
    case 'LAST_MONTH': { const s = addMonths(monthStart, -1); return { from: s, to: addDays(monthStart, -1) }; }
    case 'THIS_QUARTER': return { from: quarterStart, to: addDays(addMonths(quarterStart, 3), -1) };
    case 'LAST_QUARTER': { const s = addMonths(quarterStart, -3); return { from: s, to: addDays(quarterStart, -1) }; }
    case 'THIS_YEAR': return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
    case 'LAST_YEAR': return { from: `${p.year - 1}-01-01`, to: `${p.year - 1}-12-31` };
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function resolveRange(timezone: string, preset: string, from?: string, to?: string, now = new Date()): Range {
  const today = todayIso(timezone, now);
  let days: { from: string; to: string };
  let used: string = preset;
  if (preset === 'CUSTOM' || (!isPreset(preset) && (from || to))) {
    used = 'CUSTOM';
    if (!from || !to || !ISO.test(from) || !ISO.test(to) || !parseIsoDate(from) || !parseIsoDate(to)) throw Errors.validation({ from: 'Choose a start and end date.' });
    days = { from, to };
  } else if (isPreset(preset)) {
    days = presetDays(preset as Exclude<Preset, 'CUSTOM'>, today);
  } else {
    throw Errors.validation({ preset: 'Unknown date range.' });
  }
  if (days.to < days.from) throw Errors.validation({ to: 'The end date cannot be before the start date.' });
  if ((Date.parse(days.to) - Date.parse(days.from)) / 86_400_000 > MAX_DAYS) throw Errors.validation({ to: 'Choose a period of at most about two years.' });
  return { preset: used, from: days.from, to: days.to, start: dayRange(days.from, timezone).start, end: dayRange(days.to, timezone).end };
}

/** Every period (day / week start / month start) in the range, so charts show quiet periods as zero instead of skipping them. */
export function periodKeys(range: { from: string; to: string }, unit: 'day' | 'week' | 'month'): string[] {
  const out: string[] = [];
  let cur = unit === 'day' ? range.from : unit === 'week' ? weekStart(range.from) : `${range.from.slice(0, 7)}-01`;
  while (cur <= range.to) {
    out.push(cur);
    cur = unit === 'day' ? addDays(cur, 1) : unit === 'week' ? addDays(cur, 7) : addMonths(cur, 1);
    if (out.length > 1000) break;
  }
  return out;
}

/** Pick a sensible bucket for the length of the range. */
export function autoUnit(range: { from: string; to: string }): 'day' | 'week' | 'month' {
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
  return days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
}
