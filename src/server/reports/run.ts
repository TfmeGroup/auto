import { Errors } from '@/lib/errors';
import { todayIso } from '@/lib/tz';
import { Prisma, withTenant } from '@/server/db/client';
import { canUseFeature, requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { visibleLocationIds } from '@/server/workshop/people';
import { loadConfig } from '@/server/settings/config';
import type { BusinessContext } from '@/server/context';
import { describeFilters, parseParams } from './params';
import { resolveRange } from './range';
import { REPORTS, reportDef } from './registry';
import type { Column, Params, ReportDef, ReportResult, RunEnv } from './types';

/** The most rows an export (or a saved report run) may carry. Beyond it the person narrows the filters. */
export const EXPORT_MAX_ROWS = 50_000;

/** What the caller may open: every definition whose permissions they hold; `locked` marks those their plan does not include. */
export function availableReports(ctx: BusinessContext) {
  if (!can(ctx, 'report.view')) return [];
  return REPORTS.filter((d) => d.permissions.every((p) => can(ctx, p))).map((d) => ({
    key: d.key, title: d.title, description: d.description, category: d.category, dated: d.dated, filters: d.filters, groupBys: d.groupBys ?? [],
    locked: d.feature ? !canUseFeature(ctx.subscription, d.feature) : false, feature: d.feature ?? null, sensitive: !!d.sensitive,
  }));
}

/** Throw unless the caller may run this definition: report.view, the definition's own permissions, and its plan feature. */
export function assertCanRun(ctx: BusinessContext, def: ReportDef): void {
  requirePermission(ctx, 'report.view');
  for (const p of def.permissions) requirePermission(ctx, p);
  if (def.feature) requireFeature(ctx.subscription, def.feature);
}

export interface RunOptions {
  /** Return every matching row (up to EXPORT_MAX_ROWS) instead of one page. */
  all?: boolean;
}

export async function runReport(ctx: BusinessContext, key: string, query: unknown, opts: RunOptions = {}): Promise<ReportResult> {
  const def = reportDef(key);
  if (!def) throw Errors.notFound('Report');
  assertCanRun(ctx, def);
  return execute(ctx, def, query, opts);
}

/** Run without the report.view / definition permission check: the caller (custom/scheduled runs) has done its own, per-recipient. */
export async function execute(ctx: BusinessContext, def: ReportDef, query: unknown, opts: RunOptions = {}): Promise<ReportResult> {
  const tz = ctx.business.timezone;
  let params: Params = parseParams(query, def.filters, (def.groupBys ?? []).map((g) => g.key));
  if (opts.all) params = { ...params, page: 1, pageSize: EXPORT_MAX_ROWS + 1 };

  return withTenant(ctx.business.id, async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = 25000`;
    const config = await loadConfig(tx, ctx.business.id);
    const preset = params.preset || (def.dated ? config.reportDefaultRange : 'THIS_MONTH');
    const range = resolveRange(tz, preset, params.from, params.to);
    const scope = await visibleLocationIds(tx, ctx);
    if (scope) {
      for (const l of params.locationIds) if (!scope.includes(l)) throw Errors.forbidden('You do not have access to that location.');
    }
    // Several locations at once is a multi-location feature; one location (or none) is always allowed.
    if (params.locationIds.length > 1) requireFeature(ctx.subscription, 'multi_location');

    const env: RunEnv = {
      tx, ctx, params, range, scope,
      config: { slowMovingDays: config.slowMovingDays, lapsedCustomerDays: config.lapsedCustomerDays },
      can: (p) => can(ctx, p),
      today: todayIso(tz),
      loc(alias, o = {}) {
        const col = Prisma.raw(`${alias}.${o.column ?? 'location_id'}`);
        const parts: Prisma.Sql[] = [];
        if (scope) {
          parts.push(o.includeNull === false ? Prisma.sql`${col} = ANY(${scope}::uuid[])` : scope.length ? Prisma.sql`(${col} IS NULL OR ${col} = ANY(${scope}::uuid[]))` : Prisma.sql`${col} IS NULL`);
        }
        if (params.locationIds.length) parts.push(Prisma.sql`${col} = ANY(${params.locationIds}::uuid[])`);
        return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
      },
      eq(column, value, cast) {
        if (value === undefined || value === '') return Prisma.empty;
        const c = Prisma.raw(column);
        return cast ? Prisma.sql`AND ${c} = ${value}::${Prisma.raw(cast)}` : Prisma.sql`AND ${c} = ${value}`;
      },
    };

    const out = await def.run(env);
    const visible = out.columns.filter((c) => !c.needs || can(ctx, c.needs));
    const keep = new Set<string>(visible.map((c) => c.key));
    for (const c of visible) if (c.link) keep.add(c.link.idKey);
    const hiddenKeys = new Set(out.columns.filter((c) => c.needs && !can(ctx, c.needs)).map((c) => c.key));
    const rows = out.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k)))) as Record<string, unknown>[];
    const summary = (out.summary ?? []).filter((m) => (!m.needs || can(ctx, m.needs)) && !hiddenKeys.has(m.key));
    const total = out.total ?? rows.length;
    if (opts.all && total > EXPORT_MAX_ROWS) throw Errors.validation({ filters: `This report has more than ${EXPORT_MAX_ROWS.toLocaleString('en')} rows. Narrow the date range or filters.` });
    return {
      key: def.key, title: def.title, category: def.category,
      range: def.dated ? { preset: range.preset, from: range.from, to: range.to, timezone: tz } : null,
      columns: visible as Column[], rows: opts.all ? rows.slice(0, EXPORT_MAX_ROWS) : rows, total, page: params.page, pageSize: params.pageSize, paged: !!def.paged,
      summary, charts: (out.charts ?? []).map((c) => ({ ...c, series: c.series.filter((s) => !s.needs || can(ctx, s.needs)) })).filter((c) => c.series.length > 0), notes: out.notes ?? [],
      appliedFilters: describeFilters(params), generatedAt: new Date().toISOString(), currency: ctx.business.currency, locale: ctx.business.locale,
    };
  });
}
