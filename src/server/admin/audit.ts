import { z } from 'zod';
import { Prisma, prisma, withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { dayRange } from '@/lib/tz';
import { toCsv } from '@/lib/tabular';
import { escapeLike, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import type { BusinessContext } from '@/server/context';

/**
 * Audit and security administration. The audit log is append-only: the database refuses UPDATE and DELETE, and there is no write API at all.
 * This module only READS it (with filters), and exports it for people allowed to.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
export const auditSearchSchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  action: z.string().max(80).optional(),
  resourceType: z.string().max(40).optional(),
  userId: uuidSchema.optional(),
  from: day.optional(),
  to: day.optional(),
});

/** Actions that concern who can do what, and how data leaves the business. Shown on the Security events screen. */
export const SECURITY_PREFIXES = ['member.', 'role.', 'business.ownership', 'business.mfa', 'business.closed', 'business.close', 'config.security', 'data.export', 'report.exported', 'audit.exported', 'finance.exported', 'inventory.exported', 'team.exported', 'import.', 'file.purged', 'location.'];

function conditions(ctx: BusinessContext, q: z.output<typeof auditSearchSchema>, opts: { security?: boolean }): Prisma.Sql[] {
  const tz = ctx.business.timezone;
  const c: Prisma.Sql[] = [Prisma.sql`a.business_id = ${ctx.business.id}::uuid`];
  if (opts.security) c.push(Prisma.sql`(${Prisma.join(SECURITY_PREFIXES.map((p) => Prisma.sql`a.action LIKE ${`${escapeLike(p)}%`}`), ' OR ')})`);
  if (q.action) c.push(Prisma.sql`a.action LIKE ${`${escapeLike(q.action)}%`}`);
  if (q.resourceType) c.push(Prisma.sql`a.resource_type = ${q.resourceType}`);
  if (q.userId) c.push(Prisma.sql`a.user_id = ${q.userId}::uuid`);
  if (q.from) c.push(Prisma.sql`a.created_at >= ${dayRange(q.from, tz).start}`);
  if (q.to) c.push(Prisma.sql`a.created_at < ${dayRange(q.to, tz).end}`);
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    c.push(Prisma.sql`(a.action ILIKE ${like} OR a.resource_type ILIKE ${like} OR a.resource_id ILIKE ${like} OR u.name ILIKE ${like})`);
  }
  return c;
}

/** Only these metadata fields are shown for a security event (never addresses, devices or request details). */
const SAFE_META = ['role', 'name', 'report', 'format', 'rows', 'kind', 'status', 'scope', 'section', 'file', 'imported', 'locations'];
const safeMeta = (m: unknown): Record<string, unknown> => {
  if (!m || typeof m !== 'object') return {};
  return Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([k, v]) => SAFE_META.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))));
};

async function run(ctx: BusinessContext, q: z.output<typeof auditSearchSchema>, opts: { security?: boolean; all?: boolean }) {
  const where = Prisma.join(conditions(ctx, q, opts), ' AND ');
  return withTenant(ctx.business.id, async (tx) => {
    const total = Number((await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where}`))[0]!.n);
    const limit = opts.all ? 20_001 : q.pageSize;
    const offset = opts.all ? 0 : (q.page - 1) * q.pageSize;
    const rows = await tx.$queryRaw<{ id: string; action: string; resource_type: string | null; resource_id: string | null; created_at: Date; user_name: string | null; user_id: string | null; metadata: unknown }[]>(Prisma.sql`
      SELECT a.id, a.action, a.resource_type, a.resource_id, a.created_at, a.user_id, u.name AS user_name, a.metadata
        FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`);
    return { total, rows };
  });
}

export async function searchAuditLog(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'audit.view');
  const q = parseOrThrow(auditSearchSchema, query);
  const { total, rows } = await run(ctx, q, {});
  return {
    items: rows.map((r) => ({ id: r.id, action: r.action, user: r.user_id ? (r.user_name ?? 'Unknown user') : 'System', userId: r.user_id, resourceType: r.resource_type, resourceId: r.resource_id, createdAt: r.created_at })),
    meta: pageMeta(q.page, q.pageSize, total),
  };
}

/** Business-level security and data-movement events, and each member's sign-in protection status. */
export async function listSecurityEvents(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'security.view_events');
  requireFeature(ctx.subscription, 'advanced_admin');
  const q = parseOrThrow(auditSearchSchema, query);
  const { total, rows } = await run(ctx, q, { security: true });
  return {
    items: rows.map((r) => ({ id: r.id, action: r.action, user: r.user_id ? (r.user_name ?? 'Unknown user') : 'System', resourceType: r.resource_type, createdAt: r.created_at, details: safeMeta(r.metadata) })),
    meta: pageMeta(q.page, q.pageSize, total),
  };
}

/**
 * Sign-in protection per member: two-factor on or off, when they were last active, how many devices are signed in. Individual sign-in and
 * failed-sign-in events belong to the person's own account (they are not visible to a business, by design); what a business needs to know is whether its
 * people are protected.
 */
export async function memberSignInStatus(ctx: BusinessContext) {
  requirePermission(ctx, 'security.view_events');
  requireFeature(ctx.subscription, 'advanced_admin');
  const members = await prisma().membership.findMany({
    where: { businessId: ctx.business.id, status: { in: ['ACTIVE', 'SUSPENDED'] }, userId: { not: null } },
    include: { user: { select: { id: true, name: true, mfaEnabled: true, passwordChangedAt: true } }, role: { select: { name: true } } },
  });
  const ids = members.map((m) => m.userId!).filter(Boolean);
  const sessions = ids.length ? await prisma().session.groupBy({ by: ['userId'], where: { userId: { in: ids }, revokedAt: null, expiresAt: { gt: new Date() } }, _max: { lastUsedAt: true }, _count: true }) : [];
  const by = new Map(sessions.map((s) => [s.userId, s]));
  return members.map((m) => ({
    membershipId: m.id, name: m.user?.name ?? 'Member', role: m.role.name, status: m.status, isOwner: m.isOwner, mfaEnabled: !!m.user?.mfaEnabled,
    lastActiveAt: by.get(m.userId!)?._max.lastUsedAt ?? null, signedInDevices: by.get(m.userId!)?._count ?? 0, passwordChangedAt: m.user?.passwordChangedAt ?? null,
  })).sort((a, b) => Number(a.mfaEnabled) - Number(b.mfaEnabled) || a.name.localeCompare(b.name));
}

/** The audit log as a file, for people allowed to take business data out. The export is itself audited. */
export async function exportAuditLog(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'audit.view');
  requirePermission(ctx, 'business.export');
  requireFeature(ctx.subscription, 'data_export');
  await consume({ key: `audit-export:${ctx.business.id}`, limit: 10, windowSec: 3600 });
  const q = parseOrThrow(auditSearchSchema, query);
  const { rows } = await run(ctx, q, { all: true });
  if (rows.length > 20_000) throw Errors.validation({ filters: 'More than 20,000 entries match. Narrow the dates or filters.' });
  const data = toCsv(
    [{ header: 'When (UTC)', kind: 'text' }, { header: 'Who', kind: 'text' }, { header: 'Action', kind: 'text' }, { header: 'Record type', kind: 'text' }, { header: 'Record id', kind: 'text' }],
    rows.map((r) => [r.created_at.toISOString().replace('T', ' ').slice(0, 19), r.user_id ? (r.user_name ?? 'Unknown user') : 'System', r.action, r.resource_type ?? '', r.resource_id ?? '']),
  );
  await withTenant(ctx.business.id, (tx) => recordAudit(tx, ctx.meta, { action: AuditActions.auditExported, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'audit_log', metadata: { rows: rows.length, filters: { action: q.action, from: q.from, to: q.to } } }));
  return { data, filename: `audit-log-${new Date().toISOString().slice(0, 10)}.csv` };
}

