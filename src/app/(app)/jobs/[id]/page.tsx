import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { ActivityTimeline, Row, Stat, Tabs, kmFmt, qs } from '@/components/workshop/layout';
import { ApprovalBadge, InspectionStatusBadge, JobStatusBadge, PriorityBadge, WorkPriorityBadge } from '@/components/workshop/badges';
import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import { CustomerLinkButton } from '@/components/documents/CustomerLinkButton';
import { AssignPanel, JobPhotoUploader, QualityCheckForm, SignaturePad, StatusControls, VisibilityToggle } from '@/components/workshop/JobControls';
import { InspectionBoard } from '@/components/workshop/InspectionBoard';
import { getJobCard } from '@/server/jobcards/service';
import { getRules, getWorkshopLookups } from '@/server/workshop/service';
import { isOpen, type JobStatus } from '@/server/jobcards/transitions';
import { JobStatusName } from '@/components/workshop/job-labels';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { isAppError } from '@/lib/errors';
import { JobFinancePanel } from '@/components/finance/FinanceTabs';
import { JobPartsPanel } from '@/components/workshop/JobPartsPanel';
import { TimerWidget } from '@/components/team/TimerWidget';
import { ManualTimeForm, TimeEntryActions } from '@/components/team/TimeEntryForm';
import { listAssignmentHistory } from '@/server/team/assignments';
import { listTimeEntries } from '@/server/team/time';

export const metadata: Metadata = { title: 'Job card' };
export const dynamic = 'force-dynamic';

type Ctx = Awaited<ReturnType<typeof requireBusiness>>;
type Card_ = Awaited<ReturnType<typeof getJobCard>>;
interface TabProps { ctx: Ctx; card: Card_; can: (p: Parameters<Ctx['permissions']['has']>[0]) => boolean; fmt: (d: Date) => string; money: (c: number | null | undefined) => string }

const FUEL: Record<string, string> = { EMPTY: 'Empty', QUARTER: '¼', HALF: '½', THREE_QUARTERS: '¾', FULL: 'Full' };
const SOURCE: Record<string, string> = { INSPECTION_ITEM: 'From an inspection finding', DIAGNOSIS: 'From a diagnosis', MANUAL: 'Added by hand' };

async function OverviewTab({ ctx, card, can, fmt }: TabProps) {
  const { job } = card;
  const status = job.status as JobStatus;
  const open = isOpen(status);
  const canWork = card.canWork;
  const rules = await getRules(ctx);
  const lookups = can('job.assign') && open ? await getWorkshopLookups(ctx) : null;
  const ci = card.checkIn;
  return (
    <div className="space-y-4">
      {open && card.transitions.length > 0 && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Move the job on</h2>
          <StatusControls jobId={job.id} status={status} transitions={card.transitions} canOverride={can('job.override_status')} canCancel={can('job.cancel')} canComplete={can('job.complete')} />
        </Card>
      )}
      {status === 'QUALITY_CHECK' && can('job.quality_check') && canWork && (
        <Card><h2 className="mb-2 text-base font-semibold">Quality check</h2><QualityCheckForm jobId={job.id} /></Card>
      )}
      {job.status === 'COMPLETED' && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">Completed</h2>
          <p className="text-sm text-muted">{job.completedAt ? fmt(job.completedAt) : ''}{job.mileageOutKm ? ` · ${kmFmt(job.mileageOutKm)}` : ''}</p>
          {job.completionSummary && <p className="mt-1 whitespace-pre-wrap text-sm">{job.completionSummary}</p>}
        </Card>
      )}
      {job.status === 'CANCELLED' && <Alert tone="warn">This job was cancelled{job.cancelReason ? `: ${job.cancelReason}` : '.'}</Alert>}
      {job.status === 'ON_HOLD' && <Alert tone="warn">On hold — it resumes at {job.heldFromStatus ? <JobStatusName status={job.heldFromStatus} /> : 'its previous step'}.</Alert>}

      <JobFinancePanel ctx={ctx} jobId={job.id} jobStatus={job.status} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-base font-semibold">Customer and vehicle</h2>
          <dl className="divide-y divide-line">
            <Row label="Customer"><Link href={`/customers/${job.customer.id}`} className="text-brand-700 hover:underline">{job.customer.name}</Link></Row>
            <Row label="Mobile">{job.customer.mobile && <a className="text-brand-700 hover:underline" href={`tel:${job.customer.mobile.replace(/[^\d+]/g, '')}`}>{job.customer.mobile}</a>}</Row>
            <Row label="Vehicle"><Link href={`/vehicles/${job.vehicle.id}`} className="text-brand-700 hover:underline">{[job.vehicle.registration, job.vehicle.make, job.vehicle.model].filter(Boolean).join(' · ')}</Link></Row>
            <Row label="Mileage in">{kmFmt(job.mileageInKm)}</Row>
            <Row label="Complaint"><span className="whitespace-pre-wrap">{job.complaint}</span></Row>
          </dl>
        </Card>
        <Card>
          <h2 className="mb-1 text-base font-semibold">Job details</h2>
          <dl className="divide-y divide-line">
            <Row label="Service">{job.serviceLabel}</Row>
            <Row label="Technician">{[job.technicianName, ...card.additionalTechnicians.map((t) => t.name)].filter(Boolean).join(', ')}</Row>
            <Row label="Advisor">{job.advisorName}</Row>
            <Row label="Opened">{fmt(job.openedAt)}{job.isWalkIn ? ' · walk-in' : ''}</Row>
            <Row label="Estimated finish">{job.estimatedCompletionAt ? fmt(job.estimatedCompletionAt) : null}</Row>
            <Row label="Booking">{card.booking ? <Link href={`/bookings/${card.booking.id}`} className="text-brand-700 hover:underline">{card.booking.bookingNumber}</Link> : null}</Row>
          </dl>
          {canWork && open && can('job.edit') && (
            <details className="mt-2">
              <summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Edit job details</summary>
              <InlineForm endpoint={`/api/v1/jobs/${job.id}`} method="PATCH" submitLabel="Save" variant="secondary" resetOnSuccess={false} fields={[
                { name: 'complaint', label: 'Customer’s complaint or request', type: 'textarea', defaultValue: job.complaint ?? '', span: 'full' },
                { name: 'priority', label: 'Priority', type: 'select', defaultValue: job.priority, options: [{ value: 'LOW', label: 'Low' }, { value: 'NORMAL', label: 'Normal' }, { value: 'HIGH', label: 'High' }, { value: 'URGENT', label: 'Urgent' }] },
                { name: 'estimatedCompletionAt', label: 'Estimated completion', type: 'datetime-local', parse: 'iso' },
              ]} />
            </details>
          )}
        </Card>
      </div>

      {lookups && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Technicians</h2>
          <AssignPanel jobId={job.id} technicians={lookups.technicians} primary={job.primaryTechnicianMembershipId} additional={card.additionalTechnicians.map((t) => t.membershipId)} />
          <AssignmentHistory ctx={ctx} jobId={job.id} />
        </Card>
      )}

      <Card>
        <h2 className="mb-1 text-base font-semibold">Check-in</h2>
        {!ci ? <p className="text-sm text-muted">This job has not been checked in yet.</p> : (
          <>
            <dl className="divide-y divide-line">
              <Row label="Arrived">{fmt(ci.arrivedAt)}</Row>
              <Row label="Odometer">{kmFmt(ci.mileageKm)}</Row>
              <Row label="Fuel">{ci.fuelLevel && FUEL[ci.fuelLevel]}</Row>
              <Row label="Keys / accessories">{ci.keysAccessories}</Row>
              <Row label="Existing damage"><span className="whitespace-pre-wrap">{ci.existingDamage}</span></Row>
              <Row label="Condition"><span className="whitespace-pre-wrap">{ci.vehicleCondition}</span></Row>
              <Row label="Customer confirmation">{ci.signedAt ? `${ci.signatureName ?? 'Signed on device'} · ${fmt(ci.signedAt)}${ci.signatureFileId ? ' · signature captured' : ''}` : rules.requireCheckInSignature ? <Badge tone="warn">Required — not yet given</Badge> : 'Not recorded'}</Row>
            </dl>
            {canWork && open && can('job.edit') && (
              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Update check-in details</summary>
                <InlineForm endpoint={`/api/v1/jobs/${job.id}/check-in`} method="PATCH" submitLabel="Save check-in" variant="secondary" resetOnSuccess={false} fields={[
                  { name: 'mileageKm', label: 'Odometer (km)', type: 'number', defaultValue: ci.mileageKm !== null ? String(ci.mileageKm) : '' },
                  { name: 'fuelLevel', label: 'Fuel level', type: 'select', defaultValue: ci.fuelLevel ?? '', options: [{ value: '', label: 'Not recorded' }, ...Object.entries(FUEL).map(([value, label]) => ({ value, label }))] },
                  { name: 'keysAccessories', label: 'Keys and accessories', defaultValue: ci.keysAccessories ?? '', span: 'full' },
                  { name: 'existingDamage', label: 'Existing damage', type: 'textarea', defaultValue: ci.existingDamage ?? '', span: 'full', rows: 2 },
                  { name: 'vehicleCondition', label: 'Vehicle condition', type: 'textarea', defaultValue: ci.vehicleCondition ?? '', span: 'full', rows: 2 },
                  { name: 'signatureName', label: 'Customer confirmation (their name)', defaultValue: ci.signatureName ?? '', span: 'full' },
                ]} />
                {!ci.signatureFileId && <div className="mt-3"><p className="mb-1 text-sm font-medium">Customer signature (optional)</p><SignaturePad jobId={job.id} /></div>}
              </details>
            )}
          </>
        )}
      </Card>

      {card.qualityChecks.length > 0 && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Quality check history</h2>
          <ul className="divide-y divide-line text-sm">
            {card.qualityChecks.map((q) => (
              <li key={q.id} className="py-2"><Badge tone={q.passed ? 'ok' : 'danger'}>{q.passed ? 'Passed' : 'Failed'}</Badge> <span className="text-muted">{fmt(q.createdAt)}</span>{q.reason ? <span> — {q.reason}</span> : null}{q.notes ? <span className="block text-muted">{q.notes}</span> : null}</li>
            ))}
          </ul>
        </Card>
      )}

      {card.inspection && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Inspection report</h2>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link className="font-medium text-brand-700 hover:underline" href={`/jobs/${job.id}/report?audience=customer`}>Customer version (only what is marked for the customer)</Link>
            <Link className="font-medium text-brand-700 hover:underline" href={`/jobs/${job.id}/report?audience=internal`}>Internal version</Link>
          </div>
        </Card>
      )}
    </div>
  );
}

async function InspectionTab({ card, can }: TabProps) {
  const { job, inspection } = card;
  const canInspect = can('job.inspect') && card.canWork;
  if (!inspection) {
    return (
      <EmptyState title="No inspection yet" action={canInspect && job.status !== 'BOOKED' ? <ActionButton label="Start inspection" variant="primary" path={`/api/v1/jobs/${job.id}/inspection`} body={{}} /> : undefined}>
        {job.status === 'BOOKED' ? 'Check the vehicle in first.' : 'Start the standard inspection checklist for this vehicle.'}
      </EmptyState>
    );
  }
  const photoCount = new Map<string, number>();
  for (const p of card.photos) if (p.inspectionItemId) photoCount.set(p.inspectionItemId, (photoCount.get(p.inspectionItemId) ?? 0) + 1);
  const withWork = new Set(card.recommendedWork.map((w) => w.sourceInspectionItemId).filter((x): x is string => !!x));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <InspectionStatusBadge status={inspection.status === 'COMPLETED' ? 'GOOD' : 'NOT_CHECKED'} /> {inspection.status === 'COMPLETED' ? 'Completed' : 'In progress'}{inspection.technicianName ? ` · ${inspection.technicianName}` : ''}
      </div>
      <InspectionBoard
        jobId={job.id} canEdit={canInspect} completed={inspection.status === 'COMPLETED'}
        items={inspection.items.map((i) => ({ id: i.id, category: i.category, label: i.label, status: i.status, internalNotes: i.internalNotes, customerNotes: i.customerNotes, measurementTenths: i.measurementTenths, measurementUnit: i.measurementUnit, customerVisible: i.customerVisible, photoCount: photoCount.get(i.id) ?? 0, hasWork: withWork.has(i.id) }))}
      />
    </div>
  );
}

async function DiagnosisTab({ card, can, fmt }: TabProps) {
  const canInspect = can('job.inspect') && card.canWork && card.job.status !== 'BOOKED';
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">What was observed is kept separate from what the technician concludes. A conclusion only counts once someone confirms it, and nothing here approves a repair.</p>
      {card.diagnoses.length === 0 && <EmptyState title="No diagnostic records yet">Record symptoms, tests and findings as you work.</EmptyState>}
      {card.diagnoses.map((d) => (
        <Card key={d.id}>
          <p className="mb-2 text-sm font-semibold">{fmt(d.recordedAt)}{d.technicianName ? ` · ${d.technicianName}` : ''}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Observed</p>
              <dl className="space-y-1 text-sm">
                {d.symptoms && <div><dt className="inline font-medium">Symptoms: </dt><dd className="inline">{d.symptoms}</dd></div>}
                {d.faultCodes.length > 0 && <div><dt className="inline font-medium">Fault codes: </dt><dd className="inline">{d.faultCodes.join(', ')}</dd></div>}
                {d.testsPerformed && <div><dt className="inline font-medium">Tests: </dt><dd className="inline">{d.testsPerformed}</dd></div>}
                {d.findings && <div><dt className="inline font-medium">Findings: </dt><dd className="inline">{d.findings}</dd></div>}
              </dl>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Technician’s diagnosis</p>
              {d.diagnosis ? <p className="text-sm">{d.diagnosis}</p> : <p className="text-sm text-muted">Not stated yet.</p>}
              <p className="mt-1">{d.confirmedAt ? <Badge tone="ok">Confirmed {fmt(d.confirmedAt)}</Badge> : <Badge tone="warn">Not confirmed</Badge>}</p>
              {d.internalNotes && <p className="mt-2 text-xs text-muted">Internal: {d.internalNotes}</p>}
            </div>
          </div>
          {canInspect && (
            <div className="mt-3 space-y-2 border-t border-line pt-3">
              {d.diagnosis && !d.confirmedAt && <ActionButton label="Confirm this diagnosis" variant="primary" path={`/api/v1/jobs/${card.job.id}/diagnoses/${d.id}/confirm`} body={{}} />}
              <details>
                <summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Edit this record</summary>
                <DiagnosisFields endpoint={`/api/v1/jobs/${card.job.id}/diagnoses/${d.id}`} method="PATCH" label="Save changes" initial={d} />
              </details>
            </div>
          )}
        </Card>
      ))}
      {canInspect && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Add a diagnostic record</h2>
          <DiagnosisFields endpoint={`/api/v1/jobs/${card.job.id}/diagnoses`} method="POST" label="Save record" />
        </Card>
      )}
    </div>
  );
}

function DiagnosisFields({ endpoint, method, label, initial }: { endpoint: string; method: 'POST' | 'PATCH'; label: string; initial?: { symptoms: string | null; faultCodes: string[]; testsPerformed: string | null; findings: string | null; diagnosis: string | null; internalNotes: string | null; customerSummary: string | null } }) {
  return (
    <InlineForm endpoint={endpoint} method={method} submitLabel={label} resetOnSuccess={method === 'POST'} fields={[
      { name: 'symptoms', label: 'Symptoms reported', type: 'textarea', rows: 2, defaultValue: initial?.symptoms ?? '', span: 'full' },
      { name: 'faultCodes', label: 'Fault codes (separate with commas)', defaultValue: initial?.faultCodes.join(', ') ?? '', parse: 'codes', placeholder: 'P0301, P0420' },
      { name: 'testsPerformed', label: 'Tests performed', type: 'textarea', rows: 2, defaultValue: initial?.testsPerformed ?? '', span: 'full' },
      { name: 'findings', label: 'Findings — what you observed or measured', type: 'textarea', rows: 3, defaultValue: initial?.findings ?? '', span: 'full' },
      { name: 'diagnosis', label: 'Diagnosis — what you conclude is wrong (optional, confirm separately)', type: 'textarea', rows: 2, defaultValue: initial?.diagnosis ?? '', span: 'full' },
      { name: 'customerSummary', label: 'Summary the customer will see (optional)', type: 'textarea', rows: 2, defaultValue: initial?.customerSummary ?? '', span: 'full' },
      { name: 'internalNotes', label: 'Internal notes', type: 'textarea', rows: 2, defaultValue: initial?.internalNotes ?? '', span: 'full' },
    ]} />
  );
}

async function WorkTab({ ctx, card, can, money }: TabProps) {
  const open = isOpen(card.job.status as JobStatus);
  const canRecommend = can('job.inspect') && card.canWork && open && card.job.status !== 'BOOKED';
  const pricing = can('job.view_pricing');
  const canDecide = can('job.approve_work') && ['AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS'].includes(card.job.status);
  const diagnosisIds = card.diagnoses.map((d) => ({ value: d.id, label: `Diagnosis of ${d.recordedAt.toLocaleDateString('en-ZA')}` }));
  void ctx; void diagnosisIds;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Recommended work is a proposal. It becomes approved only when the customer’s decision is recorded here (a quote workflow will drive this same state later).</p>
      {card.recommendedWork.length === 0 && <EmptyState title="No recommended work">Add work the customer should consider, from findings or from your own judgement.</EmptyState>}
      <ul className="space-y-3">
        {card.recommendedWork.map((w) => (
          <li key={w.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{w.description}</p>
                  <p className="text-xs text-muted">{SOURCE[w.sourceType]}{w.quantity > 1 ? ` · qty ${w.quantity}` : ''}{w.estimatedMinutes ? ` · ${w.estimatedMinutes} min` : ''}{!w.customerVisible ? ' · internal only' : ''}</p>
                </div>
                <div className="flex items-center gap-1.5"><WorkPriorityBadge priority={w.priority} /><ApprovalBadge status={w.approvalStatus} />{w.completedAt && <Badge tone="ok">Done</Badge>}</div>
              </div>
              {w.partsDescription && <p className="mt-1 text-sm">Parts: {w.partsDescription}</p>}
              {pricing && (w.estimatedLabourCents != null || w.estimatedPartsCents != null) && <p className="mt-1 text-sm">Estimate: labour {money(w.estimatedLabourCents)} · parts {money(w.estimatedPartsCents)} · <strong>{money((w.estimatedLabourCents ?? 0) + (w.estimatedPartsCents ?? 0))}</strong></p>}
              {w.notes && <p className="mt-1 text-sm text-muted">{w.notes}</p>}
              {w.decidedAt && <p className="mt-1 text-xs text-muted">Decision recorded {w.approvalMethod?.toLowerCase().replace('_', ' ')}{w.decisionNote ? ` — ${w.decisionNote}` : ''}</p>}
              {canDecide && !w.completedAt && (
                <details className="mt-2">
                  <summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Record the customer’s decision</summary>
                  <InlineForm endpoint={`/api/v1/jobs/${card.job.id}/recommended-work/${w.id}/decision`} submitLabel="Record decision" resetOnSuccess={false} fields={[
                    { name: 'decision', label: 'Decision', type: 'select', defaultValue: w.approvalStatus === 'PENDING' ? 'APPROVED' : w.approvalStatus, options: [{ value: 'APPROVED', label: 'Approved' }, { value: 'DECLINED', label: 'Declined' }, { value: 'PENDING', label: 'Back to waiting for a decision' }] },
                    { name: 'method', label: 'How did the customer tell you?', type: 'select', defaultValue: 'IN_PERSON', options: [{ value: 'IN_PERSON', label: 'In person' }, { value: 'PHONE', label: 'By phone' }, { value: 'WRITTEN', label: 'In writing' }, { value: 'OTHER', label: 'Other' }] },
                    { name: 'note', label: 'Note (optional)', span: 'full' },
                  ]} />
                </details>
              )}
              {canRecommend && !w.completedAt && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <details className="w-full">
                    <summary className="min-h-11 cursor-pointer text-sm font-medium text-muted leading-[2.75rem]">Edit</summary>
                    <InlineForm endpoint={`/api/v1/jobs/${card.job.id}/recommended-work/${w.id}`} method="PATCH" submitLabel="Save changes" variant="secondary" resetOnSuccess={false} fields={[
                      { name: 'description', label: 'Work to be done', defaultValue: w.description, span: 'full' },
                      { name: 'priority', label: 'Priority', type: 'select', defaultValue: w.priority, options: [{ value: 'RECOMMENDED', label: 'Recommended' }, { value: 'IMPORTANT', label: 'Important' }, { value: 'URGENT', label: 'Urgent' }] },
                      { name: 'estimatedMinutes', label: 'Estimated time (min)', type: 'number', defaultValue: w.estimatedMinutes !== null ? String(w.estimatedMinutes) : '' },
                      ...(pricing ? [
                        { name: 'estimatedLabourCents', label: 'Labour estimate (rand)', inputMode: 'decimal' as const, defaultValue: w.estimatedLabourCents != null ? (w.estimatedLabourCents / 100).toFixed(2) : '', parse: 'cents' as const },
                        { name: 'estimatedPartsCents', label: 'Parts estimate (rand)', inputMode: 'decimal' as const, defaultValue: w.estimatedPartsCents != null ? (w.estimatedPartsCents / 100).toFixed(2) : '', parse: 'cents' as const },
                      ] : []),
                      { name: 'partsDescription', label: 'Parts needed', defaultValue: w.partsDescription ?? '', span: 'full' },
                      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, defaultValue: w.notes ?? '', span: 'full' },
                    ]} />
                    {w.approvalStatus !== 'PENDING' && <p className="mt-1 text-xs text-warn">Changing what the work is, its priority or price withdraws the customer’s decision.</p>}
                  </details>
                  <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/jobs/${card.job.id}/recommended-work/${w.id}`} confirm="Remove this recommended work?" />
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
      {canRecommend && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Recommend work</h2>
          <InlineForm endpoint={`/api/v1/jobs/${card.job.id}/recommended-work`} submitLabel="Add recommended work" fields={[
            { name: 'description', label: 'Work to be done', required: true, span: 'full' },
            { name: 'priority', label: 'Priority', type: 'select', defaultValue: 'RECOMMENDED', options: [{ value: 'RECOMMENDED', label: 'Recommended' }, { value: 'IMPORTANT', label: 'Important' }, { value: 'URGENT', label: 'Urgent' }] },
            { name: 'quantity', label: 'Quantity', type: 'number', defaultValue: '1' },
            { name: 'estimatedMinutes', label: 'Estimated time (min)', type: 'number' },
            ...(pricing ? [
              { name: 'estimatedLabourCents', label: 'Labour estimate (rand)', inputMode: 'decimal' as const, parse: 'cents' as const },
              { name: 'estimatedPartsCents', label: 'Parts estimate (rand)', inputMode: 'decimal' as const, parse: 'cents' as const },
            ] : []),
            { name: 'partsDescription', label: 'Parts needed', span: 'full' },
            { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: 'full' },
          ]} />
        </Card>
      )}
    </div>
  );
}

const ASSIGN_LABEL: Record<string, string> = { PRIMARY_ASSIGNED: 'made the main technician', PRIMARY_REMOVED: 'taken off as main technician', ADDED: 'added to the job', REMOVED: 'taken off the job' };

async function AssignmentHistory({ ctx, jobId }: { ctx: Ctx; jobId: string }) {
  const h = await listAssignmentHistory(ctx, jobId);
  if (h.length === 0) return null;
  return (
    <details className="mt-3 text-sm">
      <summary className="min-h-11 cursor-pointer font-medium text-brand-700 leading-[2.75rem]">Assignment history ({h.length})</summary>
      <ul className="divide-y divide-line">{h.map((e) => <li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5"><span><strong>{e.who}</strong> {ASSIGN_LABEL[e.action] ?? e.action}{e.by ? ` by ${e.by}` : ''}</span><span className="text-xs text-muted">{formatDateTime(e.at, ctx.business.timezone, ctx.business.locale)}</span></li>)}</ul>
    </details>
  );
}

async function JobTimePanel({ ctx, card, can }: { ctx: Ctx; card: Card_; can: TabProps['can'] }) {
  if (!ctx.subscription.features.has('technician_management') || (!can('time.record') && !can('time.view_all'))) return null;
  const open = isOpen(card.job.status as JobStatus);
  const mine = can('time.record') && card.canWork && open && ctx.subscription.canWrite;
  const r = await listTimeEntries(ctx, { jobId: card.job.id, pageSize: 50 });
  const hours = (m: number | null) => (m === null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
  return (
    <div className="space-y-3">
      {mine && <TimerWidget jobId={card.job.id} jobNumber={card.job.jobNumber} canPost={can('job.edit')} />}
      <Card>
        <h2 className="mb-2 text-base font-semibold">Time on this job</h2>
        {r.items.length === 0 ? <p className="text-sm text-muted">No time logged yet.</p> : (
          <ul className="divide-y divide-line">
            {r.items.map((e) => (
              <li key={e.id} className="space-y-1 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2"><span><strong>{e.personName}</strong> · {hours(e.durationMinutes)}{e.status === 'RUNNING' ? ' (running)' : ''}{!e.billable ? ' · not billable' : ''}</span><span className="flex items-center gap-1">{e.posted && <Badge tone="ok">on the job as labour</Badge>}{e.approved && <Badge>approved</Badge>}{e.status === 'VOIDED' && <Badge tone="danger">voided</Badge>}</span></div>
                <p className="text-xs text-muted">{formatDateTime(e.startedAt, ctx.business.timezone, ctx.business.locale)}{e.notes ? ` · ${e.notes}` : ''}{e.voidReason ? ` · voided: ${e.voidReason}` : ''}</p>
                <TimeEntryActions id={e.id} status={e.status} posted={e.posted} approved={e.approved} canEdit={can('time.edit') && ctx.subscription.canWrite} canApprove={can('time.approve') && ctx.subscription.canWrite} canPost={(can('time.edit') || (can('job.edit') && e.membershipId === ctx.membership.id)) && ctx.subscription.canWrite} />
              </li>
            ))}
          </ul>
        )}
        {r.items.length > 0 && <p className="mt-2 text-xs text-muted">Total {hours(r.totals.minutes)} · billable {hours(r.totals.billableMinutes)}</p>}
        {(mine || (can('time.edit') && ctx.subscription.canWrite)) && (
          <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Log time by hand</summary><ManualTimeForm jobId={card.job.id} /></details>
        )}
      </Card>
    </div>
  );
}

async function PartsTab({ ctx, card, can, money }: TabProps) {
  const open = isOpen(card.job.status as JobStatus);
  const canEdit = can('job.edit') && card.canWork && open;
  const pricing = can('job.view_pricing');
  return (
    <div className="space-y-4">
      <JobPartsPanel
        jobId={card.job.id} canEdit={canEdit} pricing={pricing} showCost={can('inventory.view_costs') || can('finance.view_costs')} canUseCatalogue={can('inventory.view')}
        fmt={{ currency: ctx.business.currency, locale: ctx.business.locale }}
        parts={card.parts.map((p) => ({ id: p.id, description: p.description, partNumber: p.partNumber, quantity: p.quantity, status: p.status, costCents: p.costCents, sellPriceCents: p.sellPriceCents, inventoryItemId: p.inventoryItemId, catalogue: p.catalogue, sku: p.sku, unit: p.unit, availableNow: p.availableNow }))}
      />
      <Card>
        <h2 className="mb-2 text-base font-semibold">Labour</h2>
        {card.labour.length === 0 ? <p className="text-sm text-muted">No labour recorded yet.</p> : (
          <ul className="divide-y divide-line">
            {card.labour.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span><span className="font-medium">{l.description}</span> · {l.minutes} min{l.technicianName ? ` · ${l.technicianName}` : ''}{pricing && l.totalCents != null ? ` · ${money(l.totalCents)}` : ''}</span>
                {canEdit && <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/jobs/${card.job.id}/labour/${l.id}`} confirm="Remove this labour entry?" />}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <details className="mt-2" open={card.labour.length === 0}>
            <summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Record labour</summary>
            <InlineForm endpoint={`/api/v1/jobs/${card.job.id}/labour`} submitLabel="Record labour" fields={[
              { name: 'description', label: 'Work performed', required: true, span: 'full' }, { name: 'minutes', label: 'Time (minutes)', type: 'number', required: true },
              ...(pricing ? [{ name: 'rateCentsPerHour', label: 'Hourly rate (rand)', inputMode: 'decimal' as const, parse: 'cents' as const }] : []),
            ]} />
            <p className="mt-1 text-xs text-muted">Recorded against you. If you leave the rate blank, the rate in force for the technician, service or business is used and copied onto this line.</p>
          </details>
        )}
      </Card>
      <JobTimePanel ctx={ctx} card={card} can={can} />
      {pricing && card.total && (
        <div className="grid grid-cols-3 gap-2"><Stat label="Parts" value={money(card.total.partsCents)} /><Stat label="Labour" value={money(card.total.labourCents)} /><Stat label="Recommended" value={money(card.total.recommendedCents)} /></div>
      )}
      <p className="text-xs text-muted">Parts and labour here are the working record of the job: invoices are built from parts that have been fitted and from the labour recorded.</p>
    </div>
  );
}

async function JobDocumentsTab({ ctx, card, can }: TabProps) {
  const canGenerate = can('document.view') && ctx.subscription.canWrite;
  const hasInspection = !!card.inspection && card.inspection.status === 'COMPLETED';
  return (
    <div className="space-y-4">
      <DocumentsPanel
        ctx={ctx} resourceType="job" resourceId={card.job.id} kind="documents" title="Job documents"
        generate={canGenerate ? [{ kind: 'job_summary', label: 'Make the job summary' }, ...(hasInspection ? [{ kind: 'inspection_report' as const, label: 'Make the inspection report' }] : [])] : []}
      />
      {can('document.share') && ctx.subscription.canWrite && (
        <Card className="space-y-2">
          <h2 className="text-base font-semibold">Share with the customer</h2>
          <p className="text-sm text-muted">Documents and photos reach the customer only when you mark them &ldquo;Customer can see it&rdquo;. A private link shows them exactly that and nothing else.</p>
          <CustomerLinkButton jobId={card.job.id} />
        </Card>
      )}
    </div>
  );
}

async function PhotosTab({ card, can, fmt }: TabProps) {
  const open = isOpen(card.job.status as JobStatus) || card.job.status === 'COMPLETED';
  const canEdit = can('job.edit') && card.canWork && open;
  return (
    <div className="space-y-4">
      {canEdit && <Card><h2 className="mb-2 text-base font-semibold">Check-in photos</h2><p className="mb-2 text-xs text-muted">Pick the view, then take as many photos of it as you need. Existing damage is worth a close-up.</p><JobPhotoUploader jobId={card.job.id} checkIn /></Card>}
      {canEdit && <Card><h2 className="mb-2 text-base font-semibold">Other photos</h2><JobPhotoUploader jobId={card.job.id} /></Card>}
      {card.photos.length === 0 ? <EmptyState title="No photos yet">Take photos at check-in, of damaged parts, and of the finished repair.</EmptyState> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {card.photos.map((p) => (
            <li key={p.id} className="overflow-hidden rounded-xl border border-line bg-surface">
              <a href={`/documents/${p.fileId}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/v1/files/${p.fileId}?thumb=1`} alt={p.description ?? p.category.toLowerCase().replace(/_/g, ' ')} loading="lazy" className="aspect-square w-full object-cover" />
              </a>
              <div className="space-y-1 p-2 text-xs">
                <p className="font-medium">{p.category.toLowerCase().replace(/_/g, ' ')}</p>
                {p.description && <p className="text-muted">{p.description}</p>}
                <p className="text-muted">{fmt(p.createdAt)}</p>
                <div className="flex flex-wrap items-center gap-1">
                  {canEdit ? <VisibilityToggle path={`/api/v1/jobs/${card.job.id}/photos/${p.id}`} visibility={p.visibility} /> : <Badge tone={p.visibility === 'CUSTOMER' ? 'ok' : 'neutral'}>{p.visibility === 'CUSTOMER' ? 'Customer-visible' : 'Internal'}</Badge>}
                  {canEdit && can('document.delete') && <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/jobs/${card.job.id}/photos/${p.id}`} confirm="Remove this photo from the job?" />}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function NotesTab({ card, can, fmt }: TabProps) {
  const canEdit = can('job.edit') && card.canWork;
  return (
    <div className="space-y-4">
      {canEdit && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Add a note</h2>
          <InlineForm endpoint={`/api/v1/jobs/${card.job.id}/notes`} submitLabel="Add note" fields={[
            { name: 'body', label: 'Note', type: 'textarea', required: true, span: 'full' },
            { name: 'visibility', label: 'Who can see it', type: 'select', defaultValue: 'INTERNAL', options: [{ value: 'INTERNAL', label: 'Internal — only your team' }, { value: 'CUSTOMER', label: 'Customer-visible — appears in customer updates' }] },
          ]} />
        </Card>
      )}
      {card.notes.length === 0 ? <EmptyState title="No notes yet">Internal notes stay inside your business. Mark a note customer-visible only when it is meant for them.</EmptyState> : (
        <ul className="space-y-2">
          {card.notes.map((n) => (
            <li key={n.id}>
              <Card>
                <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>{fmt(n.createdAt)}</span>
                  {canEdit ? <VisibilityToggle path={`/api/v1/jobs/${card.job.id}/notes/${n.id}`} visibility={n.visibility} /> : <Badge tone={n.visibility === 'CUSTOMER' ? 'ok' : 'neutral'}>{n.visibility === 'CUSTOMER' ? 'Customer-visible' : 'Internal'}</Badge>}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'job.view');
  const { id } = await params;
  const sp = await searchParams;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);

  let card: Card_;
  try {
    card = await getJobCard(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const { job } = card;
  const fmt = (d: Date) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);
  const money = (c: number | null | undefined) => (c == null ? '—' : formatMoney(c, ctx.business.currency, ctx.business.locale));
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'inspection', label: 'Inspection' },
    { key: 'diagnosis', label: 'Diagnosis' },
    { key: 'work', label: `Work${card.recommendedWork.length ? ` (${card.recommendedWork.length})` : ''}` },
    { key: 'parts', label: 'Parts & labour' },
    { key: 'photos', label: `Photos${card.photos.length ? ` (${card.photos.length})` : ''}` },
    { key: 'documents', label: 'Documents', show: can('document.view') },
    { key: 'notes', label: 'Notes' },
    { key: 'timeline', label: 'Timeline' },
  ];
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? 'overview';
  const page = Math.max(1, Number(sp.page) || 1);
  const hrefTab = (key: string) => `/jobs/${job.id}${qs({ tab: key === 'overview' ? undefined : key })}`;
  const tp: TabProps = { ctx, card, can, fmt, money };

  return (
    <>
      <PageHeader
        title={job.jobNumber}
        description={[job.vehicle.registration, [job.vehicle.make, job.vehicle.model].filter(Boolean).join(' '), job.customer.name].filter(Boolean).join(' · ')}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <JobStatusBadge status={job.status} /><PriorityBadge priority={job.priority} />
        {job.serviceLabel && <span className="text-sm text-muted">{job.serviceLabel}</span>}
        {!card.canWork && isOpen(job.status as JobStatus) && <span className="text-xs text-muted">View only — this job is not assigned to you.</span>}
      </div>
      <Tabs tabs={tabs} active={tab} hrefFor={hrefTab} />

      {tab === 'overview' && <OverviewTab {...tp} />}
      {tab === 'inspection' && <InspectionTab {...tp} />}
      {tab === 'diagnosis' && <DiagnosisTab {...tp} />}
      {tab === 'work' && <WorkTab {...tp} />}
      {tab === 'parts' && <PartsTab {...tp} />}
      {tab === 'photos' && <PhotosTab {...tp} />}
      {tab === 'documents' && <JobDocumentsTab {...tp} />}
      {tab === 'notes' && <NotesTab {...tp} />}
      {tab === 'timeline' && <ActivityTimeline ctx={ctx} scope={{ jobId: job.id }} page={page} hrefFor={(p) => `${hrefTab('timeline')}&page=${p}`} />}
    </>
  );
}
