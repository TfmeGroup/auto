'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { InlineForm } from '@/components/forms/InlineForm';
import { useSubmit } from '@/components/forms/use-submit';
import { api, ApiError } from '@/lib/api-client';

/** Log time by hand. Impossible entries (backwards, in the future, longer than a day, before the job existed, overlapping other time) are refused by the server. */
export function ManualTimeForm({ jobId, jobs, people }: { jobId?: string; jobs?: { id: string; label: string }[]; people?: { id: string; name: string }[] }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const key = useRef(`k-${crypto.randomUUID()}`);
  const [done, setDone] = useState(false);
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
        const start = v('start');
        const end = v('end');
        setDone(false);
        void run(async () => {
          await api('/api/v1/team/time', {
            method: 'POST',
            body: { jobId: jobId ?? v('jobId'), membershipId: v('membershipId') || undefined, startedAt: start ? new Date(start).toISOString() : '', ...(end ? { endedAt: new Date(end).toISOString() } : { durationMinutes: v('minutes') }), billable: (f.elements.namedItem('billable') as HTMLInputElement).checked, notes: v('notes'), idempotencyKey: key.current },
          });
          key.current = `k-${crypto.randomUUID()}`;
          f.reset();
          setDone(true);
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {done && !error && <Alert tone="ok">Time saved.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        {!jobId && jobs && <Field label="Job" htmlFor="mt-job" error={fields.jobId}><Select id="mt-job" name="jobId" required><option value="">Choose a job…</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>}
        {people && people.length > 0 && <Field label="Person" htmlFor="mt-person"><Select id="mt-person" name="membershipId"><option value="">Me</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>}
        <Field label="Started" htmlFor="mt-start" error={fields.startedAt}><Input id="mt-start" name="start" type="datetime-local" required aria-invalid={!!fields.startedAt} /></Field>
        <Field label="Finished" htmlFor="mt-end" error={fields.endedAt} hint="Or give the length instead."><Input id="mt-end" name="end" type="datetime-local" aria-invalid={!!fields.endedAt} /></Field>
        <Field label="Length (minutes)" htmlFor="mt-min" error={fields.durationMinutes}><Input id="mt-min" name="minutes" inputMode="numeric" /></Field>
        <Field label="What was done" htmlFor="mt-notes"><Input id="mt-notes" name="notes" maxLength={300} /></Field>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="billable" defaultChecked className="size-5" />Billable to the customer</label>
      <Button type="submit" loading={pending || !ready}>Save time</Button>
    </form>
  );
}

/** What a manager can do to one entry. Every change needs a reason and is kept with who made it. */
export function TimeEntryActions({ id, status, posted, approved, canEdit, canApprove, canPost }: { id: string; status: string; posted: boolean; approved: boolean; canEdit: boolean; canApprove: boolean; canPost: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<'edit' | 'void' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (status === 'VOIDED') return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canApprove && status === 'COMPLETED' && !approved && <Button type="button" variant="secondary" className="!min-h-9" onClick={async () => { setErr(null); try { await api(`/api/v1/team/time/${id}/approve`, { method: 'POST', body: {} }); router.refresh(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed.'); } }}>Approve</Button>}
        {canPost && status === 'COMPLETED' && !posted && <Button type="button" variant="secondary" className="!min-h-9" onClick={async () => { setErr(null); try { await api(`/api/v1/team/time/${id}/post`, { method: 'POST', body: {} }); router.refresh(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed.'); } }}>Add to job as labour</Button>}
        {canEdit && !posted && <Button type="button" variant="ghost" className="!min-h-9" onClick={() => setMode(mode === 'edit' ? null : 'edit')}>Edit</Button>}
        {canEdit && <Button type="button" variant="ghost" className="!min-h-9" onClick={() => setMode(mode === 'void' ? null : 'void')}>Void</Button>}
      </div>
      {err && <Alert>{err}</Alert>}
      {mode === 'edit' && <InlineForm endpoint={`/api/v1/team/time/${id}`} method="PATCH" submitLabel="Save change" variant="secondary" onDone={() => setMode(null)} fields={[{ name: 'startedAt', label: 'Started', type: 'datetime-local', parse: 'iso' }, { name: 'endedAt', label: 'Finished', type: 'datetime-local', parse: 'iso' }, { name: 'notes', label: 'Notes' }, { name: 'reason', label: 'Why is it being changed? (required)', required: true, span: 'full' }]} />}
      {mode === 'void' && <InlineForm endpoint={`/api/v1/team/time/${id}/void`} submitLabel="Void this time" variant="danger" onDone={() => setMode(null)} fields={[{ name: 'reason', label: 'Why? (required)', required: true, span: 'full' }]} />}
    </div>
  );
}
