import { Badge } from '@/components/ui';

/** Status and priority badges. One place defines what each state looks like, so every screen agrees. */

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';

// Job status and priority badges use the business's own names (see job-labels.tsx).
export { JobStatusBadge, PriorityBadge } from './job-labels';

const BOOKING_LABEL: Record<string, string> = {
  REQUESTED: 'Requested', CONFIRMED: 'Confirmed', REMINDER_SENT: 'Reminder sent', CHECKED_IN: 'Checked in', NO_SHOW: 'No-show', CANCELLED: 'Cancelled', RESCHEDULED: 'Rescheduled', COMPLETED: 'Completed',
};
const BOOKING_TONE: Record<string, Tone> = {
  REQUESTED: 'warn', CONFIRMED: 'brand', REMINDER_SENT: 'brand', CHECKED_IN: 'ok', NO_SHOW: 'danger', CANCELLED: 'neutral', RESCHEDULED: 'warn', COMPLETED: 'ok',
};
export const bookingStatusLabel = (s: string) => BOOKING_LABEL[s] ?? s;
export const BookingStatusBadge = ({ status }: { status: string }) => <Badge tone={BOOKING_TONE[status] ?? 'neutral'}>{bookingStatusLabel(status)}</Badge>;

const VEHICLE_LABEL: Record<string, string> = {
  ACTIVE: 'Active', AWAITING_SERVICE: 'Awaiting service', IN_WORKSHOP: 'In workshop', AWAITING_PARTS: 'Awaiting parts', REPAIR_REQUIRED: 'Repair required', INACTIVE: 'Inactive',
};
const VEHICLE_TONE: Record<string, Tone> = { ACTIVE: 'ok', AWAITING_SERVICE: 'warn', IN_WORKSHOP: 'brand', AWAITING_PARTS: 'warn', REPAIR_REQUIRED: 'danger', INACTIVE: 'neutral' };
export const vehicleStatusLabel = (s: string) => VEHICLE_LABEL[s] ?? s;
export const VehicleStatusBadge = ({ status }: { status: string }) => <Badge tone={VEHICLE_TONE[status] ?? 'neutral'}>{vehicleStatusLabel(status)}</Badge>;


const WORK_TONE: Record<string, Tone> = { RECOMMENDED: 'neutral', IMPORTANT: 'warn', URGENT: 'danger' };
export const WorkPriorityBadge = ({ priority }: { priority: string }) => <Badge tone={WORK_TONE[priority] ?? 'neutral'}>{priority.charAt(0) + priority.slice(1).toLowerCase()}</Badge>;

const APPROVAL_TONE: Record<string, Tone> = { PENDING: 'warn', APPROVED: 'ok', DECLINED: 'danger' };
export const ApprovalBadge = ({ status }: { status: string }) => <Badge tone={APPROVAL_TONE[status] ?? 'neutral'}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;

const ITEM_LABEL: Record<string, string> = { NOT_CHECKED: 'Not checked', GOOD: 'Good', ATTENTION: 'Attention', CRITICAL: 'Critical' };
const ITEM_TONE: Record<string, Tone> = { NOT_CHECKED: 'neutral', GOOD: 'ok', ATTENTION: 'warn', CRITICAL: 'danger' };
export const InspectionStatusBadge = ({ status }: { status: string }) => <Badge tone={ITEM_TONE[status] ?? 'neutral'}>{ITEM_LABEL[status] ?? status}</Badge>;

const HEALTH: Record<string, { label: string; tone: Tone }> = {
  GOOD: { label: 'Good', tone: 'ok' },
  ATTENTION_RECOMMENDED: { label: 'Attention recommended', tone: 'warn' },
  IMMEDIATE_ATTENTION: { label: 'Immediate attention', tone: 'danger' },
};
export const HealthBadge = ({ level }: { level: string }) => <Badge tone={HEALTH[level]?.tone ?? 'neutral'}>{HEALTH[level]?.label ?? level}</Badge>;

export const CustomerStatusBadge = ({ status }: { status: string }) =>
  status === 'ACTIVE' ? null : <Badge tone={status === 'ARCHIVED' ? 'warn' : 'neutral'}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;
