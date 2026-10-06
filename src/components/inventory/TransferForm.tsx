'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { PartPicker, type PickedPart } from './PartPicker';

interface Line { partId: string; label: string; quantity: string }

/** Ask for stock to move from one location to another. Availability at the sending location is checked when it is shipped, by someone who can see that location. */
export function TransferForm({ locations, approvalRequired }: { locations: { id: string; name: string }[]; approvalRequired: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [lines, setLines] = useState<Line[]>([]);
  const [from, setFrom] = useState(locations[0]?.id ?? '');
  const [to, setTo] = useState(locations[1]?.id ?? '');
  const [bad, setBad] = useState<string | null>(null);
  const add = (p: PickedPart) => setLines((ls) => (ls.some((l) => l.partId === p.id) ? ls : [...ls, { partId: p.id, label: `${p.sku} — ${p.name}`, quantity: '1' }]));

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBad(null);
        const f = e.currentTarget;
        const submit = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-submit') === 'now';
        if (lines.length === 0) { setBad('Add at least one part.'); return; }
        if (from === to) { setBad('Choose two different locations.'); return; }
        void run(async () => {
          const r = await api<{ id: string }>('/api/v1/transfers', { method: 'POST', body: { fromLocationId: from, toLocationId: to, notes: ((f.elements.namedItem('notes') as HTMLTextAreaElement).value ?? '').trim(), submit, lines: lines.map((l) => ({ partId: l.partId, quantity: l.quantity })) } });
          router.push(`/inventory/transfers/${r.data.id}`);
          router.refresh();
        });
      }}
    >
      {(bad || error) && <Alert>{bad ?? error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" htmlFor="tr-from" error={fields.fromLocationId}><Select id="tr-from" value={from} onChange={(e) => setFrom(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
        <Field label="To" htmlFor="tr-to" error={fields.toLocationId}><Select id="tr-to" value={to} onChange={(e) => setTo(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
      </div>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Parts</h2>
        <ul className="space-y-2">{lines.map((l) => (
          <li key={l.partId} className="flex items-center gap-2 rounded-lg border border-line bg-surface p-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.label}</span>
            <Input className="!w-20" inputMode="numeric" aria-label={`Quantity of ${l.label}`} value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x) => (x.partId === l.partId ? { ...x, quantity: e.target.value } : x)))} />
            <Button type="button" variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.partId !== l.partId))}>Remove</Button>
          </li>
        ))}</ul>
        {fields.lines && <p role="alert" className="text-xs font-medium text-danger">{fields.lines}</p>}
        <PartPicker onPick={add} allowScan placeholder="Search for a part to move" />
      </section>
      <Field label="Notes" htmlFor="tr-notes"><Textarea id="tr-notes" name="notes" rows={2} /></Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" data-submit="now" loading={pending || !ready}>{approvalRequired ? 'Request transfer' : 'Create transfer'}</Button>
        <Button type="submit" variant="secondary" data-submit="draft" disabled={pending}>Save as draft</Button>
      </div>
    </form>
  );
}
