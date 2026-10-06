import type { Tx } from '@/server/db/client';
import { createDocumentLink } from '@/server/finance/links';
import { sendCustomerMessage } from '@/server/notifications/comms';
import { NotificationTypes, type EventKey } from '@/server/notifications/events';
import { notifyInternal } from '@/server/notifications/internal';
import { loadCommSettings } from '@/server/notifications/settings';
import { JOB_STATUS_LABEL, type JobStatus } from './transitions';

/**
 * Customer job updates and internal status notices. A business decides which customer updates it sends (all are off until it
 * switches them on, and the plan must include them); the customer's own switches also apply. Every customer update carries a secure
 * link to the customer view of the job: customer-visible photos, the inspection report and the job summary, nothing internal.
 */
export const JOB_EVENT_BY_STATUS: Partial<Record<JobStatus, Extract<EventKey, `JOB_${string}`>>> = {
  AWAITING_APPROVAL: 'JOB_DIAGNOSIS_COMPLETE',
  APPROVED: 'JOB_WORK_APPROVED',
  IN_PROGRESS: 'JOB_WORK_STARTED',
  AWAITING_PARTS: 'JOB_AWAITING_PARTS',
  READY_FOR_COLLECTION: 'JOB_READY_FOR_COLLECTION',
  COMPLETED: 'JOB_COMPLETED',
};

interface JobLike {
  id: string;
  jobNumber: string;
  customerId: string;
  vehicleId: string;
  locationId: string | null;
  serviceLabel?: string | null;
  primaryTechnicianMembershipId?: string | null;
}

export async function messageJob(tx: Tx, businessId: string, userId: string | null, event: Extract<EventKey, `JOB_${string}`>, job: JobLike, dedupeKey: string) {
  // No link (and no message) unless this business has switched this update on.
  const settings = await loadCommSettings(tx, businessId);
  if (!settings.jobUpdateEvents.includes(event)) return [];
  const link = await createDocumentLink(tx, businessId, 'JOB', job.id, userId);
  return sendCustomerMessage(tx, businessId, {
    event, customerId: job.customerId, vehicleId: job.vehicleId, entity: { type: 'job', id: job.id }, locationId: job.locationId, link: { url: link.url }, dedupeKey,
    vars: { job_number: job.jobNumber, service_name: job.serviceLabel ?? 'service' },
  });
}

/** After a status change: the customer update (when the business sends it) and an internal notice for the people on the job. */
export async function onJobStatusChanged(tx: Tx, businessId: string, actorId: string, from: JobStatus, to: JobStatus, job: JobLike) {
  // "Work started" is when work first begins, not when a failed quality check sends it back.
  const event = JOB_EVENT_BY_STATUS[to];
  const skip = to === 'IN_PROGRESS' && (from === 'QUALITY_CHECK' || from === 'ON_HOLD');
  if (event && !skip) {
    // The link is only created if the business actually sends this update (the service says so by queuing).
    await messageJob(tx, businessId, actorId, event, job, `job:${job.id}:${event}:${from}`);
  }
  const techUser = job.primaryTechnicianMembershipId ? (await tx.membership.findFirst({ where: { id: job.primaryTechnicianMembershipId, businessId }, select: { userId: true } }))?.userId : null;
  await notifyInternal(tx, businessId, NotificationTypes.JOB_STATUS_CHANGED, {
    title: `Job ${job.jobNumber}: ${JOB_STATUS_LABEL[to]}`, linkUrl: `/jobs/${job.id}`, entity: { type: 'job', id: job.id }, alsoUserIds: techUser ? [techUser] : [], excludeUserIds: [actorId], groupKey: `job-status:${job.id}`,
  });
}
