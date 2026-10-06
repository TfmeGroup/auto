import { Prisma } from '@/server/db/client';
import { addDays, weekStart } from '@/lib/tz';
import { autoUnit, periodKeys } from '../range';
import type { ChartSpec, Column, RunEnv } from '../types';

/** Postgres returns bigint / numeric as BigInt or string; reports work in plain numbers (cents are far below 2^53). */
export const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export const pageOf = (env: RunEnv) => ({ limit: env.params.pageSize, offset: (env.params.page - 1) * env.params.pageSize });

export const isoDay = (d: Date | string | null | undefined): string | null => (d ? (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)) : null);

export type Unit = 'day' | 'week' | 'month';

/** Chart / grouping bucket: what the person chose, or one that suits the length of the range. */
export function unitFor(env: RunEnv): Unit {
  const g = env.params.groupBy;
  return g === 'day' || g === 'week' || g === 'month' ? g : autoUnit(env.range);
}

export const UNIT_GROUPS = [{ key: 'day', label: 'By day' }, { key: 'week', label: 'By week' }, { key: 'month', label: 'By month' }];

export const unitSql = (u: Unit) => Prisma.raw(`'${u}'`);

/** Local (business time zone) calendar date of a timestamp column. */
export const localDate = (col: string, tz: string) => Prisma.raw(`((${col} AT TIME ZONE '${tz.replace(/[^A-Za-z0-9_/+-]/g, '')}')::date)`);

export function periodLabel(key: string, unit: Unit): string {
  if (unit === 'day') return key;
  if (unit === 'week') return `Week of ${key}`;
  return key.slice(0, 7);
}

/** Align sparse query rows to every period in the range (missing = zero). `period` values are ISO dates. */
export function fillPeriods<T extends { period: string }>(env: RunEnv, unit: Unit, rows: T[], zero: (period: string) => T): T[] {
  const by = new Map(rows.map((r) => [r.period, r]));
  return periodKeys(env.range, unit).map((p) => by.get(p) ?? zero(p));
}

export const periodKey = (d: Date | string, unit: Unit): string => {
  const s = isoDay(d)!;
  return unit === 'day' ? s : unit === 'week' ? weekStart(s) : `${s.slice(0, 7)}-01`;
};

export function bar(title: string, unit: ChartSpec['unit'], x: string[], series: ChartSpec['series'], kind: ChartSpec['kind'] = 'bar'): ChartSpec {
  return { kind, title, unit, x, series };
}

export const col = (key: string, label: string, type: Column['type'], extra: Partial<Column> = {}): Column => ({ key, label, type, ...extra });

export const BUCKET_LABEL: Record<string, string> = { current: 'Current', d1_30: '1–30 days overdue', d31_60: '31–60 days overdue', d61_90: '61–90 days overdue', d90_plus: '90+ days overdue' };

/** SQL CASE giving an unpaid balance's ageing bucket from its due date (DATE) and today's local date. Mirrors finance/calc.ts ageBucket. */
export const bucketSql = (dueCol: string, today: string) =>
  Prisma.sql`CASE WHEN (${today}::date - ${Prisma.raw(dueCol)}) <= 0 THEN 'current' WHEN (${today}::date - ${Prisma.raw(dueCol)}) <= 30 THEN 'd1_30'
    WHEN (${today}::date - ${Prisma.raw(dueCol)}) <= 60 THEN 'd31_60' WHEN (${today}::date - ${Prisma.raw(dueCol)}) <= 90 THEN 'd61_90' ELSE 'd90_plus' END`;

export { addDays };
