'use client';

import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Textarea } from '@/components/ui';
import { InlineForm } from '@/components/forms/InlineForm';
import { JobPhotoUploader } from '@/components/workshop/JobControls';
import { api, ApiError } from '@/lib/api-client';

export interface BoardItem {
  id: string;
  category: string;
  label: string;
  status: 'NOT_CHECKED' | 'GOOD' | 'ATTENTION' | 'CRITICAL';
  internalNotes: string | null;
  customerNotes: string | null;
  measurementTenths: number | null;
  measurementUnit: string | null;
  customerVisible: boolean;
  photoCount: number;
  hasWork: boolean;
}

const CATEGORY: Record<string, string> = { EXTERIOR: 'Exterior / body', TYRES_WHEELS: 'Tyres / wheels', MECHANICAL: 'Mechanical', OTHER: 'Other' };
const ORDER = ['EXTERIOR', 'TYRES_WHEELS', 'MECHANICAL', 'OTHER'];
const BTN = {
  GOOD: { label: 'Good', on: 'border-ok bg-ok text-white', off: 'border-line bg-surface text-ok' },
  ATTENTION: { label: 'Attention', on: 'border-warn bg-warn text-white', off: 'border-line bg-surface text-warn' },
  CRITICAL: { label: 'Critical', on: 'border-danger bg-danger text-white', off: 'border-line bg-surface text-danger' },
} as const;

/**
 * The inspection checklist, built for a phone in a workshop: three large buttons per item, notes and photos only when
 * wanted. Each tap saves straight away. Nothing here approves or prices work; a finding only becomes recommended work
 * when someone presses "Recommend work" for it.
 */
export function InspectionBoard({ jobId, items, canEdit, completed }: { jobId: string; items: BoardItem[]; canEdit: boolean; completed: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusyId(id); setError(null);
    try {
      await api(`/api/v1/jobs/${jobId}/inspection/items/${id}`, { method: 'PATCH', body });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'We could not save that. Check your connection and try again.');
    } finally { setBusyId(null); }
  }

  async function complete() {
    setCompleting(true); setError(null);
    try { await api(`/api/v1/jobs/${jobId}/inspection/complete`, { body: {} }); router.refresh(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'We could not reach the server.'); }
    finally { setCompleting(false); }
  }

  const checked = items.filter((i) => i.status !== 'NOT_CHECKED').length;
  const cats = [...new Set(items.map((i) => i.category))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  return (
    <div className="space-y-5">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-muted">{checked} of {items.length} items recorded{completed ? ' · inspection completed' : ''}.</p>
      {cats.map((cat) => (
        <section key={cat} aria-label={CATEGORY[cat]}>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{CATEGORY[cat] ?? cat}</h3>
          <ul className="space-y-2">
            {items.filter((i) => i.category === cat).map((i) => {
              const expanded = open === i.id;
              return (
                <li key={i.id} className="rounded-xl border border-line bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => setOpen(expanded ? null : i.id)} className="flex min-h-11 flex-1 items-center gap-2 text-left" aria-expanded={expanded}>
                      <span className="font-medium">{i.label}</span>
                      {i.measurementTenths !== null && <span className="text-sm text-muted">{i.measurementTenths / 10} {i.measurementUnit ?? ''}</span>}
                      {i.photoCount > 0 && <span className="text-xs text-muted">· {i.photoCount} photo{i.photoCount === 1 ? '' : 's'}</span>}
                      {!i.customerVisible && <span className="text-xs text-muted">· internal only</span>}
                    </button>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-2" role="group" aria-label={`${i.label} status`}>
                    {(['GOOD', 'ATTENTION', 'CRITICAL'] as const).map((s) => (
                      <button
                        key={s} type="button" disabled={!canEdit || busyId === i.id} aria-pressed={i.status === s}
                        onClick={() => void patch(i.id, { status: i.status === s ? 'NOT_CHECKED' : s })}
                        className={clsx('min-h-12 rounded-lg border-2 text-sm font-semibold transition-colors disabled:opacity-60', i.status === s ? BTN[s].on : BTN[s].off)}
                      >
                        {BTN[s].label}
                      </button>
                    ))}
                  </div>
                  {expanded && (
                    <div className="mt-3 space-y-3 border-t border-line pt-3">
                      <ItemDetails jobId={jobId} item={i} canEdit={canEdit} busy={busyId === i.id} onSave={(b) => patch(i.id, b)} />
                      {canEdit && !completed && i.status !== 'NOT_CHECKED' && <JobPhotoUploader jobId={jobId} inspectionItemId={i.id} defaultCategory="DIAGNOSTIC_EVIDENCE" compact />}
                      {canEdit && (i.status === 'ATTENTION' || i.status === 'CRITICAL') && !i.hasWork && <RecommendFromItem jobId={jobId} item={i} />}
                      {i.hasWork && <p className="text-sm text-muted">Work has been recommended for this finding.</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {canEdit && (
        <>
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="min-h-11 cursor-pointer text-sm font-semibold leading-[2.75rem]">Add an item to this inspection</summary>
            <InlineForm endpoint={`/api/v1/jobs/${jobId}/inspection/items`} submitLabel="Add item" variant="secondary" fields={[
              { name: 'label', label: 'What is being inspected?', required: true },
              { name: 'category', label: 'Section', type: 'select', defaultValue: 'MECHANICAL', options: [{ value: 'EXTERIOR', label: 'Exterior / body' }, { value: 'TYRES_WHEELS', label: 'Tyres / wheels' }, { value: 'MECHANICAL', label: 'Mechanical' }, { value: 'OTHER', label: 'Other' }] },
            ]} />
          </details>
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="min-h-11 cursor-pointer text-sm font-semibold leading-[2.75rem]">Overall notes and summary for the customer</summary>
            <InlineForm endpoint={`/api/v1/jobs/${jobId}/inspection`} method="PATCH" submitLabel="Save notes" variant="secondary" resetOnSuccess={false} fields={[
              { name: 'customerSummary', label: 'Summary the customer will see', type: 'textarea', span: 'full' },
              { name: 'internalNotes', label: 'Internal notes (never shown to the customer)', type: 'textarea', span: 'full' },
            ]} />
          </details>
          {!completed && <Button type="button" className="min-h-12 w-full text-base" loading={completing} onClick={complete}>Complete inspection</Button>}
        </>
      )}
    </div>
  );
}

function ItemDetails({ item, canEdit, busy, onSave }: { jobId: string; item: BoardItem; canEdit: boolean; busy: boolean; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const [internal, setInternal] = useState(item.internalNotes ?? '');
  const [customer, setCustomer] = useState(item.customerNotes ?? '');
  const [measure, setMeasure] = useState(item.measurementTenths !== null ? String(item.measurementTenths / 10) : '');
  const [unit, setUnit] = useState(item.measurementUnit ?? '');
  const [visible, setVisible] = useState(item.customerVisible);
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Measurement" htmlFor={`m-${item.id}`}><Input id={`m-${item.id}`} inputMode="decimal" value={measure} onChange={(e) => setMeasure(e.target.value)} disabled={!canEdit} /></Field>
        <Field label="Unit" htmlFor={`u-${item.id}`}><Input id={`u-${item.id}`} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="mm, kPa, V…" disabled={!canEdit} /></Field>
      </div>
      <Field label="Note for the customer report" htmlFor={`c-${item.id}`}><Textarea id={`c-${item.id}`} rows={2} value={customer} onChange={(e) => setCustomer(e.target.value)} disabled={!canEdit} /></Field>
      <Field label="Internal note (never shown to the customer)" htmlFor={`i-${item.id}`}><Textarea id={`i-${item.id}`} rows={2} value={internal} onChange={(e) => setInternal(e.target.value)} disabled={!canEdit} /></Field>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={visible} onChange={(e) => setVisible(e.target.checked)} disabled={!canEdit} /> Include this item in the customer’s report</label>
      {canEdit && <Button type="button" variant="secondary" loading={busy} onClick={() => void onSave({ measurement: measure, measurementUnit: unit, customerNotes: customer, internalNotes: internal, customerVisible: visible })}>Save item details</Button>}
    </div>
  );
}

function RecommendFromItem({ jobId, item }: { jobId: string; item: BoardItem }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Recommend work for this finding</Button>;
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <p className="mb-2 text-sm font-medium">Recommend work — this is a proposal for the customer to approve; it does not approve anything.</p>
      <InlineForm
        endpoint={`/api/v1/jobs/${jobId}/recommended-work`}
        submitLabel="Add recommended work"
        extra={{ sourceInspectionItemId: item.id }}
        onDone={() => setOpen(false)}
        fields={[
          { name: 'description', label: 'Work to be done', required: true, defaultValue: `Attend to ${item.label.toLowerCase()}`, span: 'full' },
          { name: 'priority', label: 'Priority', type: 'select', defaultValue: item.status === 'CRITICAL' ? 'URGENT' : 'IMPORTANT', options: [{ value: 'RECOMMENDED', label: 'Recommended' }, { value: 'IMPORTANT', label: 'Important' }, { value: 'URGENT', label: 'Urgent' }] },
          { name: 'estimatedMinutes', label: 'Estimated time (minutes)', type: 'number' },
          { name: 'partsDescription', label: 'Parts needed', span: 'full' },
        ]}
      />
    </div>
  );
}

