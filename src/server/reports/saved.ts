import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { memberNames } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import { customConfigSchema, customDef } from './custom/engine';
import { exportDef, type ExportFormat } from './export';
import { parseParams } from './params';
import { assertCanRun, execute } from './run';
import { reportDef } from './registry';
import type { ReportResult } from './types';

/**
 * Saved reports: a remembered configuration (a standard report with its filters, or a custom report), with an owner and a visibility.
 * SHARING NEVER SHARES DATA. A shared report is only a recipe: everyone who runs it runs it as themselves, with their own permissions,
 * locations and plan, and a custom report that includes a field the viewer may not see refuses to run for them instead of hiding the gap.
 */

export const savedInputSchema = z.object({
  kind: z.enum(['STANDARD', 'CUSTOM']),
  reportKey: z.string().max(40).optional(),
  name: z.string().trim().min(2, 'Give the report a name.').max(80),
  description: z.string().trim().max(300).nullable().optional(),
  config: z.unknown(),
  visibility: z.enum(['PRIVATE', 'SHARED', 'BUSINESS']).default('PRIVATE'),
  sharedRoleIds: z.array(z.uuid()).max(20).default([]),
  sharedMembershipIds: z.array(z.uuid()).max(50).default([]),
});
export const savedUpdateSchema = savedInputSchema.omit({ kind: true, reportKey: true }).partial();

export interface StoredConfig { [k: string]: unknown }

/** Params a stored configuration passes to the report framework. */
export function paramsOf(kind: string, config: unknown): Record<string, unknown> {
  if (kind === 'STANDARD') return { ...(config as Record<string, unknown>) };
  const c = customConfigSchema.parse(config);
  return { ...(c.dateRange ?? {}), locationIds: c.locationIds };
}

/** Check a configuration and return the form to store. A custom report is dry-run so it can never be saved with a mistake or a field the author lacks. */
async function validateConfig(ctx: BusinessContext, kind: 'STANDARD' | 'CUSTOM', reportKey: string | undefined, name: string, config: unknown): Promise<StoredConfig> {
  if (kind === 'STANDARD') {
    const def = reportDef(reportKey ?? '');
    if (!def) throw Errors.validation({ reportKey: 'Unknown report.' });
    assertCanRun(ctx, def);
    const p = parseParams(config ?? {}, def.filters, (def.groupBys ?? []).map((g) => g.key));
    const { page: _p, pageSize: _s, ...keep } = p;
    void _p; void _s;
    await execute(ctx, def, { ...keep, page: 1, pageSize: 10 });
    return JSON.parse(JSON.stringify(keep)) as StoredConfig;
  }
  requirePermission(ctx, 'report.create_custom');
  requireFeature(ctx.subscription, 'custom_reports');
  const cfg = parseOrThrow(customConfigSchema, config);
  await execute(ctx, customDef(cfg, name), { ...paramsOf('CUSTOM', cfg), page: 1, pageSize: 10 });
  return JSON.parse(JSON.stringify(cfg)) as StoredConfig;
}

async function validateSharing(tx: Tx, ctx: BusinessContext, d: { visibility: string; sharedRoleIds: string[]; sharedMembershipIds: string[] }) {
  if (d.visibility === 'BUSINESS') requirePermission(ctx, 'report.manage');
  if (d.visibility !== 'SHARED') return { roles: [] as string[], members: [] as string[] };
  if (!d.sharedRoleIds.length && !d.sharedMembershipIds.length) throw Errors.validation({ sharedWith: 'Choose who to share this report with.' });
  const roles = d.sharedRoleIds.length ? await tx.role.findMany({ where: { id: { in: d.sharedRoleIds }, OR: [{ businessId: null }, { businessId: ctx.business.id }] }, select: { id: true } }) : [];
  const members = d.sharedMembershipIds.length ? await tx.membership.findMany({ where: { id: { in: d.sharedMembershipIds }, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } }) : [];
  if (roles.length !== d.sharedRoleIds.length || members.length !== d.sharedMembershipIds.length) throw Errors.validation({ sharedWith: 'Share only with roles and active members of this business.' });
  return { roles: roles.map((r) => r.id), members: members.map((m) => m.id) };
}

const visibleWhere = (ctx: BusinessContext) => ({
  businessId: ctx.business.id, archivedAt: null,
  OR: [
    { ownerMembershipId: ctx.membership.id }, { visibility: 'BUSINESS' },
    { visibility: 'SHARED', sharedMembershipIds: { has: ctx.membership.id } }, { visibility: 'SHARED', sharedRoleIds: { has: ctx.membership.roleId } },
  ],
});

export type SavedRow = NonNullable<Awaited<ReturnType<Tx['savedReport']['findFirst']>>>;

async function loadVisible(tx: Tx, ctx: BusinessContext, id: string): Promise<SavedRow> {
  const row = await tx.savedReport.findFirst({ where: { id: parseOrThrow(uuidSchema, id), ...visibleWhere(ctx) } });
  if (!row) throw Errors.notFound('Report');
  return row;
}

const canManage = (ctx: BusinessContext, row: SavedRow) => row.ownerMembershipId === ctx.membership.id || can(ctx, 'report.manage');

export async function listSavedReports(ctx: BusinessContext) {
  requirePermission(ctx, 'report.view');
  return withTenant(ctx.business.id, async (tx) => {
    const rows = await tx.savedReport.findMany({ where: visibleWhere(ctx), orderBy: { updatedAt: 'desc' }, include: { schedules: { select: { id: true, status: true } } }, take: 200 });
    const names = await memberNames(tx, ctx.business.id, rows.map((r) => r.ownerMembershipId));
    return rows.map((r) => ({
      id: r.id, kind: r.kind, reportKey: r.reportKey, name: r.name, description: r.description, visibility: r.visibility, owner: names.get(r.ownerMembershipId) ?? 'Former member',
      isOwner: r.ownerMembershipId === ctx.membership.id, canManage: canManage(ctx, r), source: r.kind === 'CUSTOM' ? (r.config as { source?: string }).source ?? null : null,
      schedules: r.schedules.length, activeSchedules: r.schedules.filter((s) => s.status === 'ACTIVE').length, updatedAt: r.updatedAt,
    }));
  });
}

export async function getSavedReport(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'report.view');
  return withTenant(ctx.business.id, async (tx) => {
    const r = await loadVisible(tx, ctx, id);
    return { id: r.id, kind: r.kind, reportKey: r.reportKey, name: r.name, description: r.description, config: r.config, visibility: r.visibility, sharedRoleIds: r.sharedRoleIds, sharedMembershipIds: r.sharedMembershipIds, isOwner: r.ownerMembershipId === ctx.membership.id, canManage: canManage(ctx, r), updatedAt: r.updatedAt };
  });
}

export async function createSavedReport(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'report.view');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(savedInputSchema, input);
  const config = await validateConfig(ctx, d.kind, d.reportKey, d.name, d.config);
  return withTenant(ctx.business.id, async (tx) => {
    if ((await tx.savedReport.count({ where: { businessId: ctx.business.id, archivedAt: null } })) >= 300) throw Errors.conflict('This business has reached the limit of 300 saved reports. Archive some first.');
    const share = await validateSharing(tx, ctx, d);
    const row = await tx.savedReport.create({
      data: {
        businessId: ctx.business.id, kind: d.kind, reportKey: d.kind === 'STANDARD' ? d.reportKey! : null, name: d.name, description: d.description ?? null, config: config as never, ownerMembershipId: ctx.membership.id,
        visibility: d.visibility, sharedRoleIds: share.roles, sharedMembershipIds: share.members,
      },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.reportSaved, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'saved_report', resourceId: row.id, metadata: { name: d.name, kind: d.kind, report: d.reportKey ?? (config as { source?: string }).source, visibility: d.visibility } });
    return { id: row.id };
  });
}

export async function updateSavedReport(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'report.view');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(savedUpdateSchema, input);
  const current = await withTenant(ctx.business.id, (tx) => loadVisible(tx, ctx, id));
  if (!canManage(ctx, current)) throw Errors.forbidden('Only the owner can change this report.');
  const name = d.name ?? current.name;
  const config = d.config !== undefined ? await validateConfig(ctx, current.kind as 'STANDARD' | 'CUSTOM', current.reportKey ?? undefined, name, d.config) : undefined;
  return withTenant(ctx.business.id, async (tx) => {
    const visibility = d.visibility ?? current.visibility;
    const share = await validateSharing(tx, ctx, { visibility, sharedRoleIds: d.sharedRoleIds ?? current.sharedRoleIds, sharedMembershipIds: d.sharedMembershipIds ?? current.sharedMembershipIds });
    await tx.savedReport.update({
      where: { id: current.id },
      data: { name, ...(d.description !== undefined ? { description: d.description } : {}), ...(config ? { config: config as never } : {}), visibility, sharedRoleIds: share.roles, sharedMembershipIds: share.members },
    });
    await recordAudit(tx, ctx.meta, { action: AuditActions.reportUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'saved_report', resourceId: current.id, metadata: { name, visibility, configChanged: !!config } });
    return { id: current.id };
  });
}

export async function archiveSavedReport(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'report.view');
  assertCanWrite(ctx.subscription);
  return withTenant(ctx.business.id, async (tx) => {
    const r = await loadVisible(tx, ctx, id);
    if (!canManage(ctx, r)) throw Errors.forbidden('Only the owner can remove this report.');
    await tx.savedReport.update({ where: { id: r.id }, data: { archivedAt: new Date() } });
    // A removed report must not keep sending: its schedules are switched off.
    await tx.reportSchedule.updateMany({ where: { businessId: ctx.business.id, savedReportId: r.id }, data: { status: 'PAUSED' } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.reportArchived, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'saved_report', resourceId: r.id, metadata: { name: r.name } });
    return { id: r.id };
  });
}

/** Run a saved report as the caller. Their own permissions decide what comes back (or whether it runs at all). */
export async function runSavedReport(ctx: BusinessContext, id: string, query: { page?: number; pageSize?: number } = {}): Promise<ReportResult & { saved: { id: string; name: string } }> {
  requirePermission(ctx, 'report.view');
  const r = await withTenant(ctx.business.id, (tx) => loadVisible(tx, ctx, id));
  const result = await runStored(ctx, r, query);
  return { ...result, saved: { id: r.id, name: r.name } };
}

export async function runStored(ctx: BusinessContext, r: Pick<SavedRow, 'kind' | 'reportKey' | 'name' | 'config'>, query: Record<string, unknown> = {}, opts: { all?: boolean } = {}): Promise<ReportResult> {
  const params = { ...paramsOf(r.kind, r.config), ...query };
  if (r.kind === 'STANDARD') {
    const def = reportDef(r.reportKey ?? '');
    if (!def) throw Errors.notFound('Report');
    assertCanRun(ctx, def);
    return { ...(await execute(ctx, def, params, opts)), title: r.name };
  }
  const def = customDef(r.config, r.name);
  assertCanRun(ctx, def);
  return execute(ctx, def, params, opts);
}

export async function exportSavedReport(ctx: BusinessContext, id: string, query: { format?: string; columns?: string }) {
  requirePermission(ctx, 'report.view');
  const r = await withTenant(ctx.business.id, (tx) => loadVisible(tx, ctx, id));
  const format = parseOrThrow(z.enum(['CSV', 'XLSX', 'PDF']).default('CSV'), query.format ?? 'CSV') as ExportFormat;
  const params = paramsOf(r.kind, r.config);
  if (r.kind === 'STANDARD') {
    const def = reportDef(r.reportKey ?? '');
    if (!def) throw Errors.notFound('Report');
    return exportDef(ctx, { ...def, title: r.name }, params, format, query.columns);
  }
  return exportDef(ctx, customDef(r.config, r.name), params, format, query.columns);
}

export async function runPreview(ctx: BusinessContext, input: unknown, query: { page?: number; pageSize?: number } = {}): Promise<ReportResult> {
  requirePermission(ctx, 'report.view');
  requirePermission(ctx, 'report.create_custom');
  requireFeature(ctx.subscription, 'custom_reports');
  const cfg = parseOrThrow(customConfigSchema, (input as { config?: unknown })?.config ?? input);
  const name = z.string().trim().max(80).catch('Custom report').parse((input as { name?: unknown })?.name) || 'Custom report';
  const def = customDef(cfg, name);
  assertCanRun(ctx, def);
  return execute(ctx, def, { ...paramsOf('CUSTOM', cfg), page: query.page ?? 1, pageSize: query.pageSize ?? 50 });
}
