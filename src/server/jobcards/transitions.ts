/**
 * The job card workflow, as data. Pure functions only (no database), so the rules are easy to read, test and
 * keep in one place.
 *
 *   Booked → Checked In → Inspection → Diagnosis → Awaiting Approval → Approved
 *          → (Awaiting Parts ↔) In Progress → Quality Check → Ready for Collection → Completed
 *
 * plus On Hold (resumes where it left off) and Cancelled. Quality Check leaves only through the quality check
 * result (pass → Ready for Collection, fail → In Progress), never by a bare status change.
 */

export const JOB_STATUSES = [
  'BOOKED', 'CHECKED_IN', 'INSPECTION', 'DIAGNOSIS', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS',
  'IN_PROGRESS', 'QUALITY_CHECK', 'READY_FOR_COLLECTION', 'COMPLETED', 'CANCELLED', 'ON_HOLD',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  BOOKED: 'Booked', CHECKED_IN: 'Checked in', INSPECTION: 'Inspection', DIAGNOSIS: 'Diagnosis', AWAITING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved', AWAITING_PARTS: 'Awaiting parts', IN_PROGRESS: 'In progress', QUALITY_CHECK: 'Quality check',
  READY_FOR_COLLECTION: 'Ready for collection', COMPLETED: 'Completed', CANCELLED: 'Cancelled', ON_HOLD: 'On hold',
};

export const TERMINAL: ReadonlySet<JobStatus> = new Set(['COMPLETED', 'CANCELLED']);
export const isOpen = (s: JobStatus) => !TERMINAL.has(s);

/** Forward moves. Cancel and hold are handled separately because they can start from many states. */
export const FORWARD: Record<JobStatus, readonly JobStatus[]> = {
  BOOKED: ['CHECKED_IN'],
  CHECKED_IN: ['INSPECTION'],
  INSPECTION: ['DIAGNOSIS'],
  DIAGNOSIS: ['AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['APPROVED'],
  APPROVED: ['AWAITING_PARTS', 'IN_PROGRESS'],
  AWAITING_PARTS: ['IN_PROGRESS'],
  IN_PROGRESS: ['QUALITY_CHECK', 'AWAITING_PARTS'],
  QUALITY_CHECK: ['READY_FOR_COLLECTION', 'IN_PROGRESS'],
  READY_FOR_COLLECTION: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  ON_HOLD: [],
};

/** Moves only the quality check result may make. */
const QUALITY_GATED = new Set<string>(['QUALITY_CHECK>READY_FOR_COLLECTION', 'QUALITY_CHECK>IN_PROGRESS']);

export type TransitionKind = 'forward' | 'hold' | 'resume' | 'cancel' | 'quality_gated' | 'override';

export interface TransitionDecision {
  allowed: boolean;
  kind?: TransitionKind;
  /** Why not (shown to the user). */
  reason?: string;
}

export interface TransitionInput {
  from: JobStatus;
  to: JobStatus;
  heldFrom?: JobStatus | null;
  override?: boolean;
}

export function decideTransition({ from, to, heldFrom, override }: TransitionInput): TransitionDecision {
  if (from === to) return { allowed: false, reason: `The job is already ${JOB_STATUS_LABEL[from].toLowerCase()}.` };
  if (override) return { allowed: true, kind: 'override' };

  if (TERMINAL.has(from)) return { allowed: false, reason: `A ${JOB_STATUS_LABEL[from].toLowerCase()} job cannot be changed.` };
  if (to === 'CANCELLED') return { allowed: true, kind: 'cancel' };

  if (from === 'ON_HOLD') {
    return heldFrom && to === heldFrom
      ? { allowed: true, kind: 'resume' }
      : { allowed: false, reason: `Resume the job to ${heldFrom ? JOB_STATUS_LABEL[heldFrom] : 'its previous step'} first.` };
  }
  if (to === 'ON_HOLD') return from === 'BOOKED' ? { allowed: false, reason: 'A job that has not arrived yet cannot be put on hold; cancel the booking instead.' } : { allowed: true, kind: 'hold' };

  if (FORWARD[from].includes(to)) {
    return QUALITY_GATED.has(`${from}>${to}`)
      ? { allowed: false, kind: 'quality_gated', reason: 'Record the quality check result: a pass moves the job to Ready for Collection, a fail returns it to In Progress.' }
      : { allowed: true, kind: 'forward' };
  }
  return {
    allowed: false,
    reason: `A job cannot go from ${JOB_STATUS_LABEL[from]} to ${JOB_STATUS_LABEL[to]}. ${FORWARD[from].length ? `Next: ${FORWARD[from].map((s) => JOB_STATUS_LABEL[s]).join(' or ')}.` : ''}`.trim(),
  };
}

/** The statuses a person could pick next, ignoring who they are. Used to draw the buttons. */
export function nextStatuses(from: JobStatus, heldFrom?: JobStatus | null): { to: JobStatus; kind: TransitionKind }[] {
  if (TERMINAL.has(from)) return [];
  const out: { to: JobStatus; kind: TransitionKind }[] = [];
  if (from === 'ON_HOLD') {
    if (heldFrom) out.push({ to: heldFrom, kind: 'resume' });
  } else {
    for (const to of FORWARD[from]) if (!QUALITY_GATED.has(`${from}>${to}`)) out.push({ to, kind: 'forward' });
    if (from !== 'BOOKED') out.push({ to: 'ON_HOLD', kind: 'hold' });
  }
  out.push({ to: 'CANCELLED', kind: 'cancel' });
  return out;
}

/** Statuses from which a job has arrived and the workshop is dealing with it. */
export const WORKSHOP_STATUSES: ReadonlySet<JobStatus> = new Set(['CHECKED_IN', 'INSPECTION', 'DIAGNOSIS', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY_FOR_COLLECTION', 'ON_HOLD']);

export const QUALITY_CHECKLIST = [
  { key: 'work_completed', label: 'Work completed', optional: false },
  { key: 'parts_installed', label: 'Parts installed', optional: false },
  { key: 'tools_removed', label: 'Tools removed', optional: false },
  { key: 'vehicle_inspected', label: 'Vehicle inspected', optional: false },
  { key: 'test_drive', label: 'Test drive (where required)', optional: true },
  { key: 'requested_work_completed', label: 'Requested work completed', optional: false },
] as const;

/** The default inspection checklist (spec categories). Each business can add items per inspection. */
export const INSPECTION_TEMPLATE: { category: 'EXTERIOR' | 'TYRES_WHEELS' | 'MECHANICAL'; key: string; label: string; unit?: string }[] = [
  { category: 'EXTERIOR', key: 'body', label: 'Body' },
  { category: 'EXTERIOR', key: 'paint', label: 'Paint' },
  { category: 'EXTERIOR', key: 'windows', label: 'Windows' },
  { category: 'EXTERIOR', key: 'mirrors', label: 'Mirrors' },
  { category: 'EXTERIOR', key: 'lights', label: 'Lights' },
  { category: 'EXTERIOR', key: 'wipers', label: 'Wipers' },
  { category: 'EXTERIOR', key: 'windscreen', label: 'Windscreen' },
  { category: 'EXTERIOR', key: 'visible_damage', label: 'Visible damage' },
  { category: 'TYRES_WHEELS', key: 'tyre_condition', label: 'Tyre condition' },
  { category: 'TYRES_WHEELS', key: 'tread_condition', label: 'Tread condition', unit: 'mm' },
  { category: 'TYRES_WHEELS', key: 'tyre_pressure', label: 'Tyre pressure', unit: 'kPa' },
  { category: 'TYRES_WHEELS', key: 'wheels_rims', label: 'Wheels / rims' },
  { category: 'MECHANICAL', key: 'engine', label: 'Engine' },
  { category: 'MECHANICAL', key: 'brakes', label: 'Brakes' },
  { category: 'MECHANICAL', key: 'suspension', label: 'Suspension' },
  { category: 'MECHANICAL', key: 'battery', label: 'Battery' },
  { category: 'MECHANICAL', key: 'fluids', label: 'Fluids' },
  { category: 'MECHANICAL', key: 'belts_hoses', label: 'Belts / hoses' },
];
