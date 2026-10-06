import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { notifyInApp, emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { loadJob } from '@/server/jobcards/common';
import { requirePermission } from '@/server/permissions/authorize';
import { memberNames } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import type { JobRow } from '@/server/jobcards/common';

/**
 * Who was put on or taken off a job, by whom, and when. The history is append-only (a database trigger refuses edits), and the people
 * concerned are told: a person put on a job gets a notice (in the app, and by email unless they switched that off).
 */

export interface AssignmentDelta {
  primaryBefore: string | null;
  primaryAfter: string | null;
  extrasBefore: string[];
  extrasAfter: string[];
}

export async function recordAssignmentChanges(tx: Tx, ctx: BusinessContext, job: JobRow, d: AssignmentDelta): Promise<void> {
  const events: { membershipId: string; action: string }[] = [];
  if (d.primaryBefore !== d.primaryAfter) {
    if (d.primaryBefore) events.push({ membershipId: d.primaryBefore, action: 'PRIMARY_REMOVED' });
    if (d.primaryAfter) events.push({ membershipId: d.primaryAfter, action: 'PRIMARY_ASSIGNED' });
  }
  const before = new Set(d.extrasBefore);
  const after = new Set(d.extrasAfter);
  for (const m of after) if (!before.has(m)) events.push({ membershipId: m, action: 'ADDED' });
  for (const m of before) if (!after.has(m)) events.push({ membershipId: m, action: 'REMOVED' });
  if (events.length === 0) return;
  await tx.jobAssignmentEvent.createMany({ data: events.map((e) => ({ businessId: ctx.business.id, jobId: job.id, membershipId: e.membershipId, action: e.action, byUserId: ctx.user.id })) });

  const gained = events.filter((e) => e.action === 'PRIMARY_ASSIGNED' || e.action === 'ADDED').map((e) => e.membershipId);
  const lost = events.filter((e) => e.action === 'PRIMARY_REMOVED' || e.action === 'REMOVED').map((e) => e.membershipId);
  const members = await tx.membership.findMany({ where: { businessId: ctx.business.id, id: { in: [...gained, ...lost] } }, select: { id: true, user: { select: { id: true, email: true, name: true, firstName: true, status: true } } } });
  const byMember = new Map(members.map((m) => [m.id, m.user]));
  const tell = async (membershipId: string, title: string, body: string, type: string) => {
    const u = byMember.get(membershipId);
    if (!u || u.status !== 'ACTIVE' || u.id === ctx.user.id) return;
    await notifyInApp(tx, { businessId: ctx.business.id, userId: u.id, type, title, body, linkUrl: `/jobs/${job.id}` });
    await emailUser(tx, { id: u.id, email: u.email, name: u.firstName || u.name }, 'job_assignments', (to, name) => templates.inventoryNotice(to, name, ctx.business.name, title, body), { businessId: ctx.business.id });
  };
  for (const m of gained) await tell(m, `You were assigned to job ${job.jobNumber}`, `${ctx.user.name} put you on job ${job.jobNumber}.`, 'JOB_ASSIGNED');
  for (const m of lost) await tell(m, `You were taken off job ${job.jobNumber}`, `${ctx.user.name} took you off job ${job.jobNumber}.`, 'JOB_UNASSIGNED');
}

/** The assignment history of one job (who, what, by whom, when), oldest first. */
export async function listAssignmentHistory(ctx: BusinessContext, jobId: string) {
  requirePermission(ctx, 'job.view');
  parseOrThrow(uuidSchema, jobId);
  return withTenant(ctx.business.id, async (tx) => {
    await loadJob(tx, ctx, jobId);
    const rows = await tx.jobAssignmentEvent.findMany({ where: { businessId: ctx.business.id, jobId }, orderBy: { createdAt: 'asc' } });
    const people = await memberNames(tx, ctx.business.id, rows.map((r) => r.membershipId));
    const users = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.byUserId).filter((v): v is string => !!v))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ id: r.id, action: r.action, who: people.get(r.membershipId) ?? 'Former member', by: r.byUserId ? (users.get(r.byUserId) ?? null) : null, at: r.createdAt }));
  });
}

