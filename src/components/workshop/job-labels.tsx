'use client';

import { createContext, useContext } from 'react';
import { Badge } from '@/components/ui';
import { JOB_STATUS_LABEL, type JobStatus } from '@/server/jobcards/transitions';

/**
 * The business's own names for job statuses and priorities (Settings, Jobs), made available to every screen from one place so they all agree.
 * Without a provider (or for a status it does not know) the standard names are used, so nothing ever shows blank.
 */
export interface JobLabels {
  status: Record<string, string>;
  priority: Record<string, string>;
}

const STANDARD: JobLabels = { status: JOB_STATUS_LABEL, priority: { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' } };
const Ctx = createContext<JobLabels>(STANDARD);

export function JobLabelsProvider({ labels, children }: { labels: JobLabels; children: React.ReactNode }) {
  return <Ctx.Provider value={labels}>{children}</Ctx.Provider>;
}
export const useJobLabels = () => useContext(Ctx);

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';
const JOB_TONE: Record<JobStatus, Tone> = {
  BOOKED: 'neutral', CHECKED_IN: 'brand', INSPECTION: 'brand', DIAGNOSIS: 'brand', AWAITING_APPROVAL: 'warn', APPROVED: 'ok',
  AWAITING_PARTS: 'warn', IN_PROGRESS: 'brand', QUALITY_CHECK: 'brand', READY_FOR_COLLECTION: 'ok', COMPLETED: 'ok', CANCELLED: 'neutral', ON_HOLD: 'warn',
};
const PRIORITY_TONE: Record<string, Tone> = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warn', URGENT: 'danger' };

export function JobStatusBadge({ status }: { status: string }) {
  const l = useJobLabels();
  return <Badge tone={JOB_TONE[status as JobStatus] ?? 'neutral'}>{l.status[status] ?? JOB_STATUS_LABEL[status as JobStatus] ?? status}</Badge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const l = useJobLabels();
  return priority === 'NORMAL' ? null : <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{l.priority[priority] ?? priority.charAt(0) + priority.slice(1).toLowerCase()}</Badge>;
}

/** The business's name for a status, as plain text (for sentences). */
export function JobStatusName({ status }: { status: string }) {
  const l = useJobLabels();
  return <>{l.status[status] ?? JOB_STATUS_LABEL[status as JobStatus] ?? status}</>;
}
