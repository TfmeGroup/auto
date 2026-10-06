'use client';

import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { JOB_STATUSES, QUALITY_CHECKLIST, type JobStatus } from '@/server/jobcards/transitions';
import { useJobLabels } from './job-labels';

/** Interactive controls on a job card. Every one posts to the API, which re-checks permission, the workflow and who is assigned. */

interface Transition { to: JobStatus; kind: string }

const FORWARD_LABEL: Partial<Record<JobStatus, string>> = {
  CHECKED_IN: 'Check in', INSPECTION: 'Start inspection', DIAGNOSIS: 'Move to diagnosis', AWAITING_APPROVAL: 'Ask for approval', APPROVED: 'Mark approved',
  AWAITING_PARTS: 'Waiting for parts', IN_PROGRESS: 'Start work', QUALITY_CHECK: 'Send to quality check', READY_FOR_COLLECTION: 'Ready for collection', COMPLETED: 'Complete job',
};

export function StatusControls({ jobId, status, transitions, canOverride, canCancel, canComplete }: { jobId: string; status: JobStatus; transitions: Transition[]; canOverride: boolean; canCancel: boolean; canComplete: boolean }) {
  const LABEL = useJobLabels().status as Record<JobStatus, string>;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<null | { to: JobStatus; kind: string }>(null);
  const [reason, setReason] = useState('');
  const [mileage, setMileage] = useState('');
  const [summary, setSummary] = useState('');
  const [overriding, setOverriding] = useState(false);
  const [overrideTo, setOverrideTo] = useState<JobStatus>('IN_PROGRESS');

  async function send(to: JobStatus, extra: Record<string, unknown> = {}) {
    setBusy(true); setError(null);
    try {
      await api(`/api/v1/jobs/${jobId}/status`, { body: { status: to, expectedStatus: status, ...extra } });
      setAsking(null); setReason(''); setOverriding(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'We could not reach the server. Nothing was changed.');
    } finally { setBusy(false); }
  }

  const visible = transitions.filter((t) => (t.to === 'CANCELLED' ? canCancel : t.to === 'COMPLETED' ? canComplete : true));
  const main = visible.filter((t) => t.kind === 'forward' || t.kind === 'resume');
  const side = visible.filter((t) => t.kind === 'hold' || t.kind === 'cancel');
  if (visible.length === 0 && !canOverride) return null;

  return (
    <div className="space-y-3">
      {error && <Alert tone="warn">{error}</Alert>}
      {status === 'QUALITY_CHECK' && <p className="text-sm text-muted">Record the quality check below to move this job on.</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {main.map((t) => (
          <Button
            key={t.to} type="button" loading={busy && !asking} className="min-h-12 w-full text-base sm:w-auto"
            onClick={() => (t.to === 'COMPLETED' ? setAsking(t) : void send(t.to))}
          >
            {t.kind === 'resume' ? `Resume (${LABEL[t.to]})` : (FORWARD_LABEL[t.to] ?? LABEL[t.to])}
          </Button>
        ))}
        {side.map((t) => (
          <Button key={t.to} type="button" variant={t.kind === 'cancel' ? 'danger' : 'secondary'} className="min-h-12 w-full sm:w-auto" onClick={() => { setAsking(t); setError(null); }}>
            {t.kind === 'cancel' ? 'Cancel job' : 'Put on hold'}
          </Button>
        ))}
      </div>

      {asking && (
        <div className="space-y-2 rounded-lg border border-line bg-canvas p-3" role="group" aria-label={`Confirm: ${LABEL[asking.to]}`}>
          {asking.to === 'COMPLETED' ? (
            <>
              <Field label="Odometer at collection (km, optional)" htmlFor="out-km"><Input id="out-km" inputMode="numeric" value={mileage} onChange={(e) => setMileage(e.target.value)} /></Field>
              <Field label="Final summary of the work (optional)" htmlFor="out-sum"><Textarea id="out-sum" value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
            </>
          ) : (
            <Field label={asking.kind === 'cancel' ? 'Why is this job being cancelled?' : 'Why is this job on hold?'} htmlFor="reason"><Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} /></Field>
          )}
          <div className="flex gap-2">
            <Button type="button" variant={asking.kind === 'cancel' ? 'danger' : 'primary'} loading={busy} onClick={() => send(asking.to, asking.to === 'COMPLETED' ? { mileageOutKm: mileage, completionSummary: summary } : { reason })}>
              {asking.to === 'COMPLETED' ? 'Complete the job' : asking.kind === 'cancel' ? 'Yes, cancel the job' : 'Put on hold'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          </div>
        </div>
      )}

      {canOverride && (
        <div>
          {!overriding ? (
            <button type="button" className="min-h-11 text-sm font-medium text-muted underline" onClick={() => setOverriding(true)}>Override the workflow…</button>
          ) : (
            <div className="space-y-2 rounded-lg border border-warn/40 bg-warn-bg p-3">
              <p className="text-sm font-medium text-warn">Overriding skips the normal rules. It is recorded in the audit log with your reason.</p>
              <Field label="Move to" htmlFor="ov-to">
                <Select id="ov-to" value={overrideTo} onChange={(e) => setOverrideTo(e.target.value as JobStatus)}>
                  {JOB_STATUSES.filter((s) => s !== status).map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
                </Select>
              </Field>
              <Field label="Reason (required)" htmlFor="ov-reason"><Textarea id="ov-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} /></Field>
              <div className="flex gap-2">
                <Button type="button" loading={busy} onClick={() => send(overrideTo, { override: true, reason })}>Override</Button>
                <Button type="button" variant="secondary" onClick={() => setOverriding(false)}>Back</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function QualityCheckForm({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, 'done' | 'not_done' | 'na'>>(() => Object.fromEntries(QUALITY_CHECKLIST.map((c) => [c.key, 'not_done'])));
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'pass' | 'fail' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(passed: boolean) {
    setBusy(passed ? 'pass' : 'fail'); setError(null); setFields({});
    try {
      const checklist = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v === 'na' ? 'na' : v === 'done']));
      await api(`/api/v1/jobs/${jobId}/quality-check`, { body: { passed, checklist, notes, reason } });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError) { setFields(e.fields); setError(e.message); } else setError('We could not reach the server.');
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {QUALITY_CHECKLIST.map((c) => (
          <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="text-sm font-medium">{c.label}</span>
            {c.optional ? (
              <Select aria-label={c.label} value={state[c.key]} onChange={(e) => setState({ ...state, [c.key]: e.target.value as 'done' })} className="max-w-44">
                <option value="not_done">Not done</option><option value="done">Done</option><option value="na">Not required</option>
              </Select>
            ) : (
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-6" checked={state[c.key] === 'done'} onChange={(e) => setState({ ...state, [c.key]: e.target.checked ? 'done' : 'not_done' })} /> Done</label>
            )}
          </li>
        ))}
      </ul>
      {fields.checklist && <p role="alert" className="text-xs font-medium text-danger">{fields.checklist}</p>}
      <Field label="Notes (optional)" htmlFor="qc-notes"><Textarea id="qc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Field label="If it fails: what is wrong?" htmlFor="qc-reason" error={fields.reason}><Textarea id="qc-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!fields.reason} /></Field>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" className="min-h-12 flex-1 text-base" loading={busy === 'pass'} disabled={!!busy} onClick={() => submit(true)}>Pass — ready for collection</Button>
        <Button type="button" variant="danger" className="min-h-12 flex-1 text-base" loading={busy === 'fail'} disabled={!!busy} onClick={() => submit(false)}>Fail — back to work</Button>
      </div>
    </div>
  );
}

export function AssignPanel({ jobId, technicians, primary, additional }: { jobId: string; technicians: { membershipId: string; name: string }[]; primary: string | null; additional: string[] }) {
  const router = useRouter();
  const [p, setP] = useState(primary ?? '');
  const [extra, setExtra] = useState<string[]>(additional);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      await api(`/api/v1/jobs/${jobId}/assign`, { body: { primaryTechnicianMembershipId: p, additionalTechnicianMembershipIds: extra.filter((m) => m !== p) } });
      setSaved(true); router.refresh();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'We could not reach the server.'); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Field label="Primary technician" htmlFor="primary">
        <Select id="primary" value={p} onChange={(e) => setP(e.target.value)}>
          <option value="">Unassigned</option>{technicians.map((t) => <option key={t.membershipId} value={t.membershipId}>{t.name}</option>)}
        </Select>
      </Field>
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Also working on it</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {technicians.filter((t) => t.membershipId !== p).map((t) => (
            <label key={t.membershipId} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" className="size-5" checked={extra.includes(t.membershipId)} onChange={(e) => setExtra(e.target.checked ? [...extra, t.membershipId] : extra.filter((m) => m !== t.membershipId))} />
              {t.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3"><Button type="button" variant="secondary" loading={busy} onClick={save}>Save assignment</Button>{saved && <span role="status" className="text-sm font-medium text-ok">Saved</span>}</div>
    </div>
  );
}

const PHOTO_CATEGORIES: [string, string][] = [
  ['CHECK_IN_FRONT', 'Check-in: front'], ['CHECK_IN_REAR', 'Check-in: rear'], ['CHECK_IN_LEFT', 'Check-in: left side'], ['CHECK_IN_RIGHT', 'Check-in: right side'], ['PARTS', 'Parts'],
  ['CHECK_IN_EXTERIOR', 'Check-in: exterior'], ['CHECK_IN_DAMAGE', 'Check-in: existing damage'], ['CHECK_IN_WHEELS', 'Check-in: wheels'], ['CHECK_IN_INTERIOR', 'Check-in: interior'],
  ['CHECK_IN_DASHBOARD', 'Check-in: dashboard'], ['CHECK_IN_MILEAGE', 'Check-in: mileage'], ['CHECK_IN_ENGINE_BAY', 'Check-in: engine bay'], ['BEFORE_REPAIR', 'Before repair'],
  ['DURING_REPAIR', 'During repair'], ['DAMAGED_COMPONENT', 'Damaged component'], ['DIAGNOSTIC_EVIDENCE', 'Diagnostic evidence'], ['COMPLETED_REPAIR', 'Completed repair'], ['OTHER', 'Other'],
];

const CHECK_IN_SHOTS: [string, string][] = [
  ['CHECK_IN_FRONT', 'Front'], ['CHECK_IN_REAR', 'Rear'], ['CHECK_IN_LEFT', 'Left side'], ['CHECK_IN_RIGHT', 'Right side'], ['CHECK_IN_INTERIOR', 'Interior'],
  ['CHECK_IN_DASHBOARD', 'Dashboard / mileage'], ['CHECK_IN_WHEELS', 'Wheels / tyres'], ['CHECK_IN_ENGINE_BAY', 'Engine bay'], ['CHECK_IN_DAMAGE', 'Existing damage'], ['OTHER', 'Other'],
];

/**
 * Take or choose photos for the job. Each is stored privately against this job and vehicle (and appears in the document library), internal unless you
 * mark it for the customer. Several can be chosen at once: each one is reported on its own, so one failure never hides the others. With `checkIn`,
 * a strip of check-in views lets staff pick Front, Rear, Left, Right, Interior, Dashboard, Wheels, Engine bay or Existing damage and take as many
 * photos of each as they like (nothing requires exactly one per view, and nothing is classified automatically: the label is the person's).
 */
export function JobPhotoUploader({ jobId, inspectionItemId, defaultCategory = 'OTHER', compact = false, checkIn = false }: { jobId: string; inspectionItemId?: string; defaultCategory?: string; compact?: boolean; checkIn?: boolean }) {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(checkIn ? 'CHECK_IN_FRONT' : defaultCategory);
  const [visibility, setVisibility] = useState<'INTERNAL' | 'CUSTOMER'>('INTERNAL');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<{ name: string; message: string }[]>([]);
  const [saved, setSaved] = useState(0);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setBusy(true); setFailed([]); setSaved(0);
    setProgress({ done: 0, total: list.length });
    const bad: { name: string; message: string }[] = [];
    let ok = 0;
    for (const [i, file] of list.entries()) {
      try {
        const form = new FormData();
        form.set('file', file);
        form.set('category', category);
        form.set('visibility', visibility);
        if (description) form.set('description', description);
        if (inspectionItemId) form.set('inspectionItemId', inspectionItemId);
        const res = await fetch(`/api/v1/jobs/${jobId}/photos`, { method: 'POST', body: form, credentials: 'same-origin' });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          bad.push({ name: file.name, message: j.error?.message ?? 'Upload failed.' });
        } else ok++;
      } catch {
        bad.push({ name: file.name, message: 'The connection was lost. Check your signal and try again.' });
      }
      setProgress({ done: i + 1, total: list.length });
    }
    setFailed(bad); setSaved(ok); setProgress(null); setBusy(false);
    if (ok > 0) { setDescription(''); router.refresh(); }
    if (camera.current) camera.current.value = '';
    if (picker.current) picker.current.value = '';
  }

  return (
    <div className="space-y-2">
      {checkIn && (
        <div role="group" aria-label="Which view of the vehicle" className="flex flex-wrap gap-1.5">
          {CHECK_IN_SHOTS.map(([v, l]) => (
            <button key={v} type="button" aria-pressed={category === v} onClick={() => setCategory(v)} className={`min-h-11 rounded-full border px-3 text-sm font-medium ${category === v ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line bg-surface hover:bg-canvas'}`}>{l}</button>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <Alert>
          {failed.length === 1 ? '1 photo was not saved:' : `${failed.length} photos were not saved:`}
          <ul className="mt-1 list-disc pl-5">{failed.map((f, i) => <li key={`${f.name}-${i}`}><strong>{f.name}</strong>: {f.message}</li>)}</ul>
        </Alert>
      )}
      {saved > 0 && failed.length === 0 && <Alert tone="ok">{saved === 1 ? 'Photo saved.' : `${saved} photos saved.`}</Alert>}
      {!compact && !checkIn && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select aria-label="Photo type" value={category} onChange={(e) => setCategory(e.target.value)}>{PHOTO_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <Input aria-label="Description (optional)" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      )}
      {checkIn && <Input aria-label="Description (optional)" placeholder="Description, e.g. scratch on the left rear door (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />}
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={visibility === 'CUSTOMER'} onChange={(e) => setVisibility(e.target.checked ? 'CUSTOMER' : 'INTERNAL')} /> The customer may see this photo</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" className="min-h-12" loading={busy} onClick={() => camera.current?.click()}>Take photo</Button>
        <Button type="button" variant="secondary" className="min-h-12" disabled={busy} onClick={() => picker.current?.click()}>Choose photos</Button>
      </div>
      {progress && <p role="status" className="text-sm text-muted">Saving photo {Math.min(progress.done + 1, progress.total)} of {progress.total}…</p>}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void upload(e.target.files)} />
      <input ref={picker} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/heic" className="hidden" onChange={(e) => void upload(e.target.files)} />
    </div>
  );
}

/** Touch/mouse signature pad. The customer signs on the device; the image is stored as a private job photo and linked to the check-in. */
export function SignaturePad({ jobId }: { jobId: string }) {
  const router = useRouter();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height };
  };
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = e.currentTarget.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext('2d')!;
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#14202b';
    const p = pos(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
    setEmpty(false);
  }
  const up = () => { drawing.current = false; };
  function clear() {
    const c = canvas.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  }
  async function save() {
    setBusy(true); setError(null);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.current!.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('empty');
      const form = new FormData();
      form.set('file', new File([blob], 'signature.png', { type: 'image/png' }));
      form.set('category', 'SIGNATURE');
      form.set('description', 'Customer signature at check-in');
      const res = await fetch(`/api/v1/jobs/${jobId}/photos`, { method: 'POST', body: form, credentials: 'same-origin' });
      const json = (await res.json().catch(() => ({}))) as { data?: { fileId: string }; error?: { message?: string } };
      if (!res.ok || !json.data) throw new ApiError(res.status, 'UPLOAD', json.error?.message ?? 'Could not save the signature.');
      await api(`/api/v1/jobs/${jobId}/check-in`, { method: 'PATCH', body: { signatureFileId: json.data.fileId } });
      clear();
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the signature. Try again.');
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <canvas
        ref={canvas} width={600} height={220} aria-label="Signature area: draw with your finger or mouse"
        className="h-40 w-full touch-none rounded-lg border border-dashed border-line bg-surface"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      />
      <div className="flex gap-2">
        <Button type="button" disabled={empty} loading={busy} onClick={save}>Save signature</Button>
        <Button type="button" variant="secondary" onClick={clear}>Clear</Button>
      </div>
    </div>
  );
}

/** A visibility toggle for a photo or note (customer-visible vs internal). */
export function VisibilityToggle({ path, visibility }: { path: string; visibility: 'INTERNAL' | 'CUSTOMER' }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button" disabled={busy}
        onClick={async () => {
          setBusy(true); setError(null);
          try { await api(path, { method: 'PATCH', body: { visibility: visibility === 'CUSTOMER' ? 'INTERNAL' : 'CUSTOMER' } }); router.refresh(); }
          catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
          finally { setBusy(false); }
        }}
        className={clsx('inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium', visibility === 'CUSTOMER' ? 'border-ok/30 bg-ok-bg text-ok' : 'border-line bg-canvas text-muted')}
        aria-label={visibility === 'CUSTOMER' ? 'Visible to the customer. Make internal' : 'Internal. Make visible to the customer'}
      >
        {visibility === 'CUSTOMER' ? 'Customer-visible' : 'Internal'}
      </button>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
    </span>
  );
}
