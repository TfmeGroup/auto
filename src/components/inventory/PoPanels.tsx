'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { useSubmit } from '@/components/forms/use-submit';
import { api, ApiError } from '@/lib/api-client';

export interface PoCan { edit: boolean; submit: boolean; approve: boolean; order: boolean; receive: boolean; cancel: boolean; closeShort: boolean; send: boolean; returns: boolean }

/** The buttons for one purchase order. What shows is decided by the server (`can`); each button's endpoint checks the permission again. */
export function PoActions({ id, status, can, supplierEmail, canSeeCosts, writable }: { id: string; status: string; can: PoCan; supplierEmail: string | null; canSeeCosts: boolean; writable: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<'reject' | 'cancel' | 'short' | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!writable) return null;
  const base = `/api/v1/purchase-orders/${id}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {can.edit && <Link href={`/purchase-orders/${id}/edit`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10">Edit</Link>}
        {can.submit && <ActionButton label="Submit for approval" variant="primary" path={`${base}/submit`} />}
        {can.approve && <ActionButton label="Approve" variant="primary" path={`${base}/approve`} />}
        {can.approve && <Button type="button" variant="secondary" onClick={() => setMode(mode === 'reject' ? null : 'reject')}>Send back</Button>}
        {can.order && <ActionButton label="Place order" variant="primary" path={`${base}/order`} confirm="Place this order? Its lines can no longer be edited." />}
        {can.receive && <Link href={`/purchase-orders/${id}/receive`} className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 md:min-h-10">Receive goods</Link>}
        {canSeeCosts && <a href={`${base}/pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10">View PDF</a>}
        {can.send && supplierEmail && canSeeCosts && (
          <Button type="button" variant="secondary" onClick={async () => {
            setErr(null);
            try { const r = await api<{ sentTo: string }>(`${base}/email`, { method: 'POST', body: {} }); setSent(`Sent to ${r.data.sentTo}.`); router.refresh(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not send.'); }
          }}>Email to supplier</Button>
        )}
        {can.closeShort && <Button type="button" variant="ghost" onClick={() => setMode(mode === 'short' ? null : 'short')}>Close short</Button>}
        {can.cancel && <Button type="button" variant="ghost" onClick={() => setMode(mode === 'cancel' ? null : 'cancel')}>Cancel order</Button>}
      </div>
      {sent && <Alert tone="ok">{sent}</Alert>}
      {err && <Alert>{err}</Alert>}
      {can.send && !supplierEmail && <p className="text-xs text-muted">Add an email address to the supplier to send orders to them from here.</p>}
      {mode === 'reject' && <InlineForm endpoint={`${base}/reject`} submitLabel="Send back to draft" variant="secondary" onDone={() => setMode(null)} fields={[{ name: 'reason', label: 'Why is it being sent back?', required: true, span: 'full' }]} />}
      {mode === 'cancel' && <InlineForm endpoint={`${base}/cancel`} submitLabel="Cancel the order" variant="danger" onDone={() => setMode(null)} fields={[{ name: 'reason', label: status === 'ORDERED' ? 'Why is it being cancelled? (required)' : 'Reason (optional)', required: status === 'ORDERED', span: 'full' }]} />}
      {mode === 'short' && <InlineForm endpoint={`${base}/close-short`} submitLabel="Close the order" variant="secondary" onDone={() => setMode(null)} fields={[{ name: 'reason', label: 'Why will the rest not be delivered?', required: true, span: 'full' }]} />}
    </div>
  );
}

export interface ReturnableLine { receiptLineId: string; partId: string; label: string; returnable: number; receiptNumber: string }

/** Send accepted goods back to the supplier. Each line is limited to what was received on that delivery and not yet returned; the original delivery is never edited. */
export function ReturnGoodsForm({ lines, locations, defaultLocationId }: { lines: ReturnableLine[]; locations: { id: string; name: string }[]; defaultLocationId: string }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const key = useRef(`k-${crypto.randomUUID()}`);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<string | null>(null);
  if (lines.length === 0) return <p className="text-sm text-muted">Nothing has been received yet, or everything received has already been returned.</p>;
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBad(null);
        const f = e.currentTarget;
        const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
        const chosen = lines.filter((l) => Number(qty[l.receiptLineId] ?? 0) > 0).map((l) => ({ partId: l.partId, receiptLineId: l.receiptLineId, quantity: Number(qty[l.receiptLineId]) }));
        if (chosen.length === 0) { setBad('Enter how many are going back on at least one line.'); return; }
        void run(async () => {
          await api('/api/v1/supplier-returns', { method: 'POST', body: { idempotencyKey: key.current, reason: v('reason'), notes: v('notes'), locationId: v('locationId') || undefined, lines: chosen } });
          setQty({});
          key.current = `k-${crypto.randomUUID()}`;
          router.refresh();
        });
      }}
    >
      {(bad || error) && <Alert>{bad ?? error}</Alert>}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {lines.map((l) => (
          <li key={l.receiptLineId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="min-w-0"><span className="block truncate font-medium">{l.label}</span><span className="text-xs text-muted">from {l.receiptNumber} · up to {l.returnable}</span></span>
            <Input className="!w-24" inputMode="numeric" aria-label={`Return quantity for ${l.label}`} value={qty[l.receiptLineId] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.receiptLineId]: e.target.value }))} />
          </li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reason (required)" htmlFor="rt-reason"><Input id="rt-reason" name="reason" required minLength={3} maxLength={300} placeholder="e.g. Faulty batch" /></Field>
        {locations.length > 1 && <Field label="Taken from" htmlFor="rt-loc"><select id="rt-loc" name="locationId" defaultValue={defaultLocationId} className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10">{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      </div>
      <Field label="Notes" htmlFor="rt-notes"><Input id="rt-notes" name="notes" maxLength={500} /></Field>
      <Button type="submit" variant="secondary" loading={pending || !ready}>Record return to supplier</Button>
    </form>
  );
}
