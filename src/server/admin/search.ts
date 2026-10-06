import { Prisma, prisma, withTenant } from '@/server/db/client';
import { escapeLike, parseOrThrow } from '@/lib/validation';
import { z } from 'zod';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { searchDocuments } from '@/server/files/search';
import { globalSearch, type SearchGroup } from '@/server/search/service';
import type { BusinessContext } from '@/server/context';

/**
 * Administration search: ordinary database search (substring matches on names, numbers and references; no ranking model, no semantic or
 * vector search) across everything the caller is allowed to see, plus team members, documents and audit events. Each source is skipped unless
 * the caller holds its permission, and every query runs inside the caller's business.
 */
const schema = z.object({ q: z.string().trim().min(2, 'Type at least 2 characters').max(100), limit: z.coerce.number().int().min(1).max(10).default(5) });

export async function adminSearch(ctx: BusinessContext, input: unknown): Promise<SearchGroup[]> {
  requirePermission(ctx, 'admin.view');
  requireFeature(ctx.subscription, 'advanced_admin');
  const { q, limit } = parseOrThrow(schema, input);
  const groups: SearchGroup[] = await globalSearch(ctx, { q, limit });
  const esc = escapeLike(q); // Prisma's "contains" does not escape LIKE wildcards: this makes % and _ literal
  const like = `%${esc}%`;
  const bid = ctx.business.id;

  if (can(ctx, 'employee.view')) {
    const rows = await prisma().membership.findMany({
      where: { businessId: bid, status: { in: ['ACTIVE', 'SUSPENDED', 'INVITED'] }, OR: [{ user: { name: { contains: esc, mode: 'insensitive' } } }, { user: { email: { contains: esc, mode: 'insensitive' } } }, { invitedEmail: { contains: esc, mode: 'insensitive' } }] },
      include: { user: { select: { name: true, email: true } }, role: { select: { name: true } } }, take: limit,
    });
    if (rows.length) groups.push({ key: 'members', label: 'Team members', items: rows.map((m) => ({ id: m.id, title: m.user?.name ?? m.invitedEmail ?? 'Invited member', subtitle: `${m.role.name} · ${m.status.toLowerCase()}`, href: `/team/${m.id}` })) });
  }
  if (can(ctx, 'document.view')) {
    const r = await searchDocuments(ctx, { q, page: 1, pageSize: limit }).catch(() => null);
    const items = ((r?.items ?? []) as { id: string; displayName?: string | null; name?: string; originalName?: string; category?: string }[]).map((f) => ({ id: f.id, title: f.displayName || f.name || f.originalName || 'Document', subtitle: f.category, href: `/documents/${f.id}` }));
    if (items.length) groups.push({ key: 'documents', label: 'Documents', items });
  }
  if (can(ctx, 'audit.view')) {
    const rows = await withTenant(bid, (tx) => tx.$queryRaw<{ id: string; action: string; resource_type: string | null; created_at: Date; name: string | null }[]>(Prisma.sql`
      SELECT a.id, a.action, a.resource_type, a.created_at, u.name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.business_id = ${bid}::uuid AND (a.action ILIKE ${like} OR a.resource_type ILIKE ${like} OR a.resource_id ILIKE ${like} OR u.name ILIKE ${like})
       ORDER BY a.created_at DESC LIMIT ${limit}`));
    if (rows.length) groups.push({ key: 'audit', label: 'Audit events', items: rows.map((r) => ({ id: r.id, title: r.action, subtitle: `${r.name ?? 'System'} · ${r.created_at.toISOString().slice(0, 16).replace('T', ' ')}`, href: `/audit?action=${encodeURIComponent(r.action)}` })) });
  }
  return groups;
}
