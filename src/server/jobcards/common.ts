import { Errors } from '@/lib/errors';
import type { Tx } from '@/server/db/client';
import { can } from '@/server/permissions/authorize';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import { isOpen, type JobStatus } from './transitions';

export type JobRow = Awaited<ReturnType<Tx['jobCard']['findFirstOrThrow']>>;

/** Is this member working on the job (primary or additional technician)? */
export async function isAssigned(tx: Tx, ctx: BusinessContext, job: Pick<JobRow, 'id' | 'primaryTechnicianMembershipId'>): Promise<boolean> {
  if (job.primaryTechnicianMembershipId === ctx.membership.id) return true;
  const extra = await tx.jobTechnician.count({ where: { businessId: ctx.business.id, jobId: job.id, membershipId: ctx.membership.id } });
  return extra > 0;
}

/**
 * Load a job for a read. A job from another business — or one at a location this member may not use — is "not found".
 */
export async function loadJob(tx: Tx, ctx: BusinessContext, jobId: string): Promise<JobRow> {
  const scope = await visibleLocationIds(tx, ctx);
  const job = await tx.jobCard.findFirst({ where: { id: jobId, businessId: ctx.business.id, ...locationWhere(scope) } });
  if (!job) throw Errors.notFound('Job');
  return job;
}

/**
 * Load a job for a change, locking its row so two people changing it are applied one after the other.
 * Rule for hands-on work: people who can assign jobs (service advisors, managers) may work on any job;
 * everyone else — technicians — only on jobs they are assigned to.
 */
export async function loadJobForWrite(tx: Tx, ctx: BusinessContext, jobId: string, opts: { allowClosed?: boolean; skipAssignment?: boolean } = {}): Promise<JobRow> {
  await loadJob(tx, ctx, jobId);
  await tx.$queryRaw`SELECT id FROM job_cards WHERE id = ${jobId}::uuid AND business_id = ${ctx.business.id}::uuid FOR UPDATE`;
  const job = await tx.jobCard.findFirstOrThrow({ where: { id: jobId, businessId: ctx.business.id } });
  if (!opts.skipAssignment && !can(ctx, 'job.assign') && !can(ctx, 'job.override_status') && !(await isAssigned(tx, ctx, job))) {
    throw Errors.forbidden('This job is not assigned to you.');
  }
  if (!opts.allowClosed && !isOpen(job.status as JobStatus)) {
    throw Errors.conflict(`This job is ${job.status.toLowerCase().replace(/_/g, ' ')} and can no longer be changed.`);
  }
  return job;
}
