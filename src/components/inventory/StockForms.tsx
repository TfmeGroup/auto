'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

const newKey = () => `k-${crypto.randomUUID()}`;

const REASONS = [
  { value: 'STOCK_COUNT', label: 'Stock count correction' }, { value: 'DAMAGED', label: 'Damaged' }, { value: 'MISSING', label: 'Missing / lost' },
  { value: 'DATA_CORRECTION', label: 'Data correction' }, { value: 'OPENING_BALANCE', label: 'Opening balance' }, { value: 'SOLD', label: 'Sold over the counter' }, { value: 'OTHER', label: 'Other' },
];

/**
 * A controlled stock change. The reason is required and recorded with who and when; the server checks the real quantities under a lock, so a stale
 * page cannot overdraw stock. The request carries a key, so a retry after a dropped connection is applied once.
 */
export function AdjustStockForm({ partId, locations, unit = 'units', onDone }: { partId: string; locations: { id: string; name: string }[]; unit?: string; onDone?: () => void }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const key = useRef(newKey());
  const [kind, setKind] = useState<'INCREASE' | 'DECREASE' | 'COUNT'>('COUNT');
  const [done, setDone] = useState<string | null>(null);

  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
        setDone(null);
        void run(async () => {
          const r = await api<{ unchanged: boolean; before?: number; after?: number; available: number }>('/api/v1/inventory/stock/adjust', {
            method: 'POST',
            body: { partId, kind, quantity: v('quantity'), reasonCode: v('reasonCode'), reason: v('reason'), locationId: v('locationId') || undefined, idempotencyKey: key.current },
          });
          key.current = newKey();
          setDone(r.data.unchanged ? 'Nothing changed: the count already matches.' : `Stock changed from ${r.data.before} to ${r.data.after}. ${r.data.available} available.`);
          f.reset();
          router.refresh();
          onDone?.();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {done && !error && <Alert tone="ok">{done}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What are you doing?" htmlFor="adj-kind">
          <Select id="adj-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="COUNT">Set to the number I counted</option><option value="INCREASE">Add stock</option><option value="DECREASE">Remove stock</option>
          </Select>
        </Field>
        <Field label={kind === 'COUNT' ? `Counted on the shelf (${unit})` : `How many (${unit})`} htmlFor="adj-qty" error={fields.quantity}>
          <Input id="adj-qty" name="quantity" inputMode="numeric" required aria-invalid={!!fields.quantity} />
        </Field>
        {locations.length > 1 && <Field label="Location" htmlFor="adj-loc"><Select id="adj-loc" name="locationId">{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
        <Field label="Reason" htmlFor="adj-code"><Select id="adj-code" name="reasonCode" defaultValue={kind === 'COUNT' ? 'STOCK_COUNT' : 'OTHER'} key={kind}>{REASONS.filter((r) => kind === 'INCREASE' ? !['DAMAGED', 'MISSING', 'SOLD'].includes(r.value) : true).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select></Field>
      </div>
      <Field label="Explain (required)" htmlFor="adj-reason" error={fields.reason}><Input id="adj-reason" name="reason" required minLength={3} maxLength={300} placeholder="e.g. Cycle count, 2 boxes damaged in the rain" aria-invalid={!!fields.reason} /></Field>
      <Button type="submit" loading={pending || !ready}>Record change</Button>
    </form>
  );
}

export function BinForm({ partId, locations, current }: { partId: string; locations: { id: string; name: string; bin: string | null; storageArea: string | null }[]; current?: string }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const [loc, setLoc] = useState(current ?? locations[0]?.id ?? '');
  const sel = locations.find((l) => l.id === loc);
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
        void run(async () => {
          await api(`/api/v1/inventory/parts/${partId}/bin`, { method: 'POST', body: { locationId: loc, bin: v('bin'), storageArea: v('storageArea') } });
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        {locations.length > 1 && <Field label="Location" htmlFor="bin-loc"><Select id="bin-loc" value={loc} onChange={(e) => setLoc(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
        <Field label="Storage area" htmlFor="bin-area"><Input key={`a${loc}`} id="bin-area" name="storageArea" defaultValue={sel?.storageArea ?? ''} /></Field>
        <Field label="Bin" htmlFor="bin-bin"><Input key={`b${loc}`} id="bin-bin" name="bin" defaultValue={sel?.bin ?? ''} /></Field>
      </div>
      <Button type="submit" variant="secondary" loading={pending || !ready}>Save bin</Button>
    </form>
  );
}
