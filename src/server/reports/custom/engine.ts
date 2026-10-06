import { z } from 'zod';
import { Prisma } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { requireFeature } from '@/server/billing/features';
import { isoDay, n } from '../defs/util';
import type { Column, ReportDef, RunEnv, RunOutput } from '../types';
import { sourceDef, type FieldDef, type SchemaCtx, type SourceDef } from './schema';

/**
 * Compiles a custom report configuration into ONE parameterised SELECT over the approved schema (schema.ts) and runs it. The configuration
 * is data: source and field keys are looked up in the schema (anything unknown is refused), operators are checked against the field's type,
 * and every value is a bound parameter. There is no path by which text from the browser becomes SQL.
 */

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scalar = z.union([z.string().max(100), z.number().finite(), z.boolean()]);

export const OPS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'isEmpty', 'notEmpty'] as const;
export const FUNCS = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'] as const;

export const customConfigSchema = z.object({
  source: z.string().max(40),
  fields: z.array(z.string().max(40)).max(20).default([]),
  filters: z.array(z.object({ field: z.string().max(40), op: z.enum(OPS), value: scalar.optional(), values: z.array(scalar).max(30).optional() })).max(10).default([]),
  groupBy: z.array(z.object({ field: z.string().max(40), grain: z.enum(['day', 'week', 'month']).optional() })).max(2).default([]),
  metrics: z.array(z.object({ fn: z.enum(FUNCS), field: z.string().max(40).optional(), label: z.string().trim().max(60).optional() })).max(6).default([]),
  sort: z.array(z.object({ column: z.string().max(60), dir: z.enum(['asc', 'desc']).default('asc') })).max(2).default([]),
  dateRange: z.object({ preset: z.string().max(20).optional(), from: iso.optional(), to: iso.optional() }).nullable().default(null),
  locationIds: z.array(z.uuid()).max(25).default([]),
});
export type CustomConfig = z.output<typeof customConfigSchema>;

const OPS_BY_TYPE: Record<string, readonly (typeof OPS)[number][]> = {
  text: ['eq', 'neq', 'contains', 'in', 'isEmpty', 'notEmpty'],
  status: ['eq', 'neq', 'in'],
  int: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isEmpty', 'notEmpty'],
  money: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isEmpty', 'notEmpty'],
  pct: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  hours: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['eq', 'gte', 'lte', 'between', 'isEmpty', 'notEmpty'],
  datetime: ['gte', 'lte', 'between'],
  bool: ['eq'],
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

function fieldOf(source: SourceDef, key: string): FieldDef {
  const f = source.fields.find((x) => x.key === key);
  if (!f) throw Errors.validation({ field: `"${key}" is not a field of ${source.label}.` });
  return f;
}

function checkValue(f: FieldDef, v: unknown): string | number | boolean {
  if (f.type === 'bool') { if (typeof v !== 'boolean') throw Errors.validation({ filters: `${f.label}: choose yes or no.` }); return v; }
  if (f.type === 'int' || f.type === 'money' || f.type === 'pct' || f.type === 'hours') { const x = Number(v); if (v === '' || v === null || !Number.isFinite(x)) throw Errors.validation({ filters: `${f.label}: enter a number.` }); return x; }
  if (f.type === 'date') { if (typeof v !== 'string' || !iso.safeParse(v).success) throw Errors.validation({ filters: `${f.label}: use a date like 2026-03-31.` }); return v; }
  const s = String(v ?? '').trim();
  if (!s) throw Errors.validation({ filters: `${f.label}: enter a value.` });
  if (f.values && !f.values.some((x) => x.value === s)) throw Errors.validation({ filters: `${f.label}: "${s}" is not one of the choices.` });
  return s;
}

function predicate(f: FieldDef, op: (typeof OPS)[number], expr: Prisma.Sql, value: unknown, values: unknown[] | undefined): Prisma.Sql {
  if (!(OPS_BY_TYPE[f.type] ?? []).includes(op)) throw Errors.validation({ filters: `"${op}" cannot be used with ${f.label}.` });
  if (op === 'isEmpty') return Prisma.sql`${expr} IS NULL`;
  if (op === 'notEmpty') return Prisma.sql`${expr} IS NOT NULL`;
  if (op === 'between') {
    if (!values || values.length !== 2) throw Errors.validation({ filters: `${f.label}: give a start and an end.` });
    const a = checkValue(f, values[0]); const b = checkValue(f, values[1]);
    return f.type === 'date' ? Prisma.sql`${expr} BETWEEN ${a}::date AND ${b}::date` : Prisma.sql`${expr} BETWEEN ${a as number} AND ${b as number}`;
  }
  if (op === 'in') {
    if (!values?.length) throw Errors.validation({ filters: `${f.label}: choose at least one value.` });
    const list = values.map((v) => String(checkValue(f, v)));
    return Prisma.sql`${expr}::text = ANY(${list}::text[])`;
  }
  const v = checkValue(f, value);
  if (op === 'contains') return Prisma.sql`${expr} ILIKE ${`%${likeEscape(String(v))}%`}`;
  const sym = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op as 'eq'];
  const s = Prisma.raw(sym);
  if (f.type === 'date') return Prisma.sql`${expr} ${s} ${v as string}::date`;
  if (f.type === 'status') return Prisma.sql`${expr}::text ${s} ${String(v)}`;
  if (f.type === 'bool') return Prisma.sql`${expr} ${s} ${v as boolean}`;
  return Prisma.sql`${expr} ${s} ${v as never}`;
}

export interface Compiled { source: SourceDef; used: FieldDef[]; mode: 'detail' | 'summary'; columns: (Column & { alias: string; fieldType: string })[]; select: Prisma.Sql; body: Prisma.Sql; groupOrdinals: number[]; orderBy: Prisma.Sql }

/** Validate a configuration against the schema and the caller's permissions, and build the query pieces. Throws a plain error for anything unapproved. */
export function compile(env: RunEnv, raw: unknown): Compiled {
  const cfg = customConfigSchema.parse(raw);
  const source = sourceDef(cfg.source);
  if (!source) throw Errors.validation({ source: 'Choose a data source.' });
  if (!source.permissions.every((p) => env.can(p))) throw Errors.forbidden(`You do not have access to ${source.label.toLowerCase()} data.`);
  if (source.feature) requireFeature(env.ctx.subscription, source.feature);
  const c: SchemaCtx = { today: env.today, tz: env.ctx.business.timezone, bid: env.ctx.business.id, scope: env.scope };
  const hasMetrics = cfg.metrics.length > 0 || cfg.groupBy.length > 0;
  if (hasMetrics && cfg.fields.length) throw Errors.validation({ fields: 'A summary report shows groups and totals. Remove the plain fields, or remove the grouping and totals.' });
  if (!hasMetrics && cfg.fields.length === 0) throw Errors.validation({ fields: 'Choose at least one field.' });

  const used: FieldDef[] = [];
  const need = (f: FieldDef) => { if (!used.includes(f)) used.push(f); return f; };
  const columns: Compiled['columns'] = [];
  const selects: Prisma.Sql[] = [];
  const outputKeys: string[] = [];
  const add = (key: string, label: string, type: Column['type'], fieldType: string, expr: Prisma.Sql) => {
    const alias = `c${columns.length}`;
    columns.push({ key: alias, label, type, alias, fieldType });
    selects.push(Prisma.sql`${expr} AS ${Prisma.raw(alias)}`);
    outputKeys.push(key);
  };
  const colType = (f: FieldDef): Column['type'] => (f.type === 'bool' ? 'text' : f.type);

  const groupExprs: Prisma.Sql[] = [];
  if (!hasMetrics) {
    for (const k of cfg.fields) { const f = need(fieldOf(source, k)); add(f.key, f.label, colType(f), f.type, f.sql(c)); }
  } else {
    for (const g of cfg.groupBy) {
      const f = need(fieldOf(source, g.field));
      if (!f.groupable) throw Errors.validation({ groupBy: `${f.label} cannot be used to group.` });
      if (g.grain && f.type !== 'date') throw Errors.validation({ groupBy: `${f.label} is not a date.` });
      const e = g.grain ? Prisma.sql`date_trunc(${Prisma.raw(`'${g.grain}'`)}, ${f.sql(c)})::date` : f.sql(c);
      groupExprs.push(e);
      add(g.grain ? `${f.key}:${g.grain}` : f.key, g.grain ? `${f.label} (${g.grain})` : f.label, colType(f), f.type, e);
    }
    const metrics = cfg.metrics.length ? cfg.metrics : [{ fn: 'count' as const, field: undefined, label: undefined }];
    metrics.forEach((m, i) => {
      if (m.fn === 'count') { add(`metric:${i}`, m.label || 'Count', 'int', 'int', Prisma.sql`COUNT(*)::int`); return; }
      if (!m.field) throw Errors.validation({ metrics: `${m.fn} needs a field.` });
      const f = need(fieldOf(source, m.field));
      if (m.fn === 'count_distinct') { add(`metric:${i}`, m.label || `Distinct ${f.label}`, 'int', 'int', Prisma.sql`COUNT(DISTINCT ${f.sql(c)})::int`); return; }
      if (m.fn === 'min' || m.fn === 'max') {
        if (!f.numeric && f.type !== 'date') throw Errors.validation({ metrics: `${m.fn} needs a number or a date.` });
        add(`metric:${i}`, m.label || `${m.fn === 'min' ? 'Lowest' : 'Highest'} ${f.label}`, colType(f), f.type, m.fn === 'min' ? Prisma.sql`MIN(${f.sql(c)})` : Prisma.sql`MAX(${f.sql(c)})`);
        return;
      }
      if (!f.numeric) throw Errors.validation({ metrics: `${f.label} is not a number, so it cannot be summed or averaged.` });
      const type: Column['type'] = f.type === 'money' ? 'money' : f.type === 'hours' ? 'hours' : 'int';
      add(`metric:${i}`, m.label || `${m.fn === 'sum' ? 'Total' : 'Average'} ${f.label}`, type, f.type, m.fn === 'sum' ? Prisma.sql`COALESCE(SUM(${f.sql(c)}),0)::numeric` : Prisma.sql`ROUND(AVG(${f.sql(c)})::numeric, ${f.type === 'money' ? 0 : 1})`);
    });
  }

  // Filters (every filtered field must be one the caller may read: filtering on a hidden field would leak it)
  const where: Prisma.Sql[] = [source.where(c)];
  for (const fl of cfg.filters) {
    const f = need(fieldOf(source, fl.field));
    where.push(predicate(f, fl.op, f.sql(c), fl.value, fl.values));
  }
  const dateField = fieldOf(source, source.dateField);
  if (cfg.dateRange && (cfg.dateRange.preset || cfg.dateRange.from)) where.push(Prisma.sql`${dateField.sql(c)} BETWEEN ${env.range.from}::date AND ${env.range.to}::date`);
  if (source.location) {
    const loc = env.loc(source.location.alias, { includeNull: source.location.includeNull });
    if (loc !== Prisma.empty) where.push(Prisma.sql`TRUE ${loc}`);
  }

  // Field-level permission: refuse the whole report rather than quietly dropping a column the author thought they had.
  const denied = used.filter((f) => f.needs && !env.can(f.needs));
  if (denied.length) throw Errors.forbidden(`You do not have access to: ${denied.map((f) => f.label).join(', ')}.`);

  // Sort by output position (never by a name from the browser)
  const orderParts: Prisma.Sql[] = [];
  const sorts = cfg.sort.length ? cfg.sort : hasMetrics ? [] : [];
  for (const s of sorts) {
    const idx = outputKeys.indexOf(s.column);
    if (idx < 0) throw Errors.validation({ sort: `"${s.column}" is not a column of this report.` });
    orderParts.push(Prisma.sql`${Prisma.raw(String(idx + 1))} ${Prisma.raw(s.dir === 'desc' ? 'DESC' : 'ASC')} NULLS LAST`);
  }
  if (!orderParts.length) orderParts.push(hasMetrics && groupExprs.length ? Prisma.sql`1 ASC` : hasMetrics ? Prisma.sql`1` : Prisma.sql`1 ASC`);

  const body = Prisma.sql`FROM ${source.from(c)} WHERE ${Prisma.join(where, ' AND ')} ${groupExprs.length ? Prisma.sql`GROUP BY ${Prisma.join(groupExprs.map((_, i) => Prisma.raw(String(i + 1))), ', ')}` : Prisma.empty}`;
  return { source, used, mode: hasMetrics ? 'summary' : 'detail', columns, select: Prisma.join(selects, ', '), body, groupOrdinals: groupExprs.map((_, i) => i + 1), orderBy: Prisma.join(orderParts, ', ') };
}

/** Which permissions a custom report needs to be exported: finance data needs finance.export, stock data inventory.export. */
export function customExportNeeds(sourceKey: string) {
  const s = sourceDef(sourceKey);
  if (!s) return null;
  return s.permissions.includes('finance.view_reports') ? ('finance.export' as const) : s.key === 'parts' || s.key === 'stock_movements' || s.key === 'purchase_orders' ? ('inventory.export' as const) : null;
}

const shown = (v: unknown, fieldType: string): unknown => {
  if (v === null || v === undefined) return null;
  if (fieldType === 'bool') return v ? 'Yes' : 'No';
  if (v instanceof Date) return isoDay(v);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && v !== null && typeof (v as { toNumber?: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber();
  if (fieldType === 'status' && typeof v === 'string') return v.replace(/_/g, ' ').toLowerCase().replace(/^./, (s) => s.toUpperCase());
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && (fieldType === 'int' || fieldType === 'money' || fieldType === 'hours' || fieldType === 'pct')) return Number(v);
  return v;
};

/** A report definition for a custom configuration, so it runs through the same framework (permissions, scope, limits, export) as a standard one. */
export function customDef(rawConfig: unknown, name: string): ReportDef {
  const cfg = customConfigSchema.parse(rawConfig);
  const source = sourceDef(cfg.source);
  if (!source) throw Errors.validation({ source: 'Choose a data source.' });
  return {
    key: 'custom', title: name, category: 'jobs', dated: !!cfg.dateRange, paged: true, sensitive: source.permissions.includes('finance.view_reports'),
    description: source.description, permissions: source.permissions, feature: 'custom_reports', filters: ['range', 'location'], exportNeeds: customExportNeeds(cfg.source),
    async run(env): Promise<RunOutput> {
      const q = compile(env, cfg);
      const limit = env.params.pageSize;
      const offset = (env.params.page - 1) * env.params.pageSize;
      const rows = await env.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${q.select} ${q.body} ORDER BY ${q.orderBy} LIMIT ${limit} OFFSET ${offset}`);
      const total = q.mode === 'summary' && q.groupOrdinals.length
        ? (await env.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS n FROM (SELECT 1 ${q.body}) g`))[0]!.n
        : q.mode === 'summary' ? 1 : (await env.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS n ${q.body}`))[0]!.n;
      return {
        columns: q.columns.map(({ key, label, type }) => ({ key, label, type })),
        rows: rows.map((r) => Object.fromEntries(q.columns.map((c) => [c.key, shown(r[c.alias], c.fieldType)]))),
        total: n(total),
        notes: ['Custom report built from the approved reporting schema. Fields you do not have permission to see are never available to you, and a shared report refuses to run for someone without that access.'],
      };
    },
  };
}
