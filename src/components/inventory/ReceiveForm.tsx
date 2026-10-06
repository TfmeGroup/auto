'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Input, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { centsToRand, randToCentsOrNull } from './shared';

export interface ReceiveLine { id: string; description: string; sku: string | null; remaining: number; unitCostCents: number | null; hasPart: boolean }

/**
 * Goods receiving, built for a phone at the loading bay: for each line type what physically arrived, how many were damaged and how many were the wrong item.
 * Damaged units are recorded but never become usable stock, and anything not delivered stays outstanding on the order. The delivery carries a key, so a double tap
 * or a retry on a bad connection is one delivery.
 */
export function ReceiveForm({ poId, number, lines, canSeeCosts, locations, defaultLocationId }: { poId: string; number: string; lines: ReceiveLine[]; canSeeCosts: boolean; locations: { id: string; name: string }[]; defaultLocationId: string }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const key = useRef(`k-${crypto.randomUUID()}`);
  const [vals, setVals] = useState<Record<string, { received: string; damaged: string; incorrect: string; cost: string; notes: string }>>(() => Object.fromEntries(lines.map((l) => [l.id, { received: '', damaged: '', incorrect: '', cost: centsToRand(l.unitCostCents), notes: '' }])));
  const [bad, setBad] = useState<string | null>(null);
  const set = (id: string, patch: Partial<(typeof vals)[string]>) => setVals((v) => ({ ...v, [id]: { ...v[id]!, ...patch } }));
  const n = (s: string) => (s.trim() === '' ? 0 : Number(s));

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBad(null);
        const f = e.currentTarget;
        const v = (name: string) => ((f.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '').trim();
        const payload = lines.map((l) => {
          const x = vals[l.id]!;
          const cost = canSeeCosts ? randToCentsOrNull(x.cost) : undefined;
          return { poLineId: l.id, quantityReceived: n(x.received), quantityDamaged: n(x.damaged), quantityIncorrect: n(x.incorrect), unitCostCents: cost === null || cost === undefined || cost === l.unitCostCents ? undefined : cost, notes: x.notes };
        }).filter((l) => l.quantityReceived + l.quantityDamaged + l.quantityIncorrect > 0);
        if (payload.length === 0) { setBad('Enter what arrived on at least one line.'); return; }
        if (payload.some((l) => [l.quantityReceived, l.quantityDamaged, l.quantityIncorrect].some((q) => !Number.isInteger(q) || q < 0))) { setBad('Quantities must be whole numbers.'); return; }
        void run(async () => {
          await api(`/api/v1/purchase-orders/${poId}/receive`, { method: 'POST', body: { idempotencyKey: key.current, locationId: v('locationId') || undefined, deliveryNoteRef: v('deliveryNoteRef'), notes: v('notes'), lines: payload } });
          router.push(`/purchase-orders/${poId}?received=1`);
          router.refresh();
        });
      }}
    >
      {(bad || error) && <Alert>{bad ?? error}</Alert>}
      <div className="flex justify-end"><Button type="button" variant="secondary" onClick={() => setVals((v) => Object.fromEntries(lines.map((l) => [l.id, { ...v[l.id]!, received: String(l.remaining) }])))}>Everything outstanding arrived</Button></div>
      <ul className="space-y-3">
        {lines.map((l) => {
          const x = vals[l.id]!;
          const total = n(x.received) + n(x.damaged) + n(x.incorrect);
          return (
            <li key={l.id} className="space-y-2 rounded-xl border border-line bg-surface p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="min-w-0 truncate font-semibold">{l.description}</p><p className="text-sm text-muted">{l.remaining} still expected</p></div>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Good" htmlFor={`g-${l.id}`}><Input id={`g-${l.id}`} inputMode="numeric" value={x.received} onChange={(e) => set(l.id, { received: e.target.value })} /></Field>
                <Field label="Damaged" htmlFor={`d-${l.id}`}><Input id={`d-${l.id}`} inputMode="numeric" value={x.damaged} onChange={(e) => set(l.id, { damaged: e.target.value })} /></Field>
                <Field label="Wrong item" htmlFor={`w-${l.id}`}><Input id={`w-${l.id}`} inputMode="numeric" value={x.incorrect} onChange={(e) => set(l.id, { incorrect: e.target.value })} /></Field>
              </div>
              {total > l.remaining && <p role="alert" className="text-xs font-medium text-danger">That is more than the {l.remaining} still expected.</p>}
              {total > 0 && total < l.remaining && <p className="text-xs text-muted">{l.remaining - total} will stay outstanding.</p>}
              <div className="grid gap-2 sm:grid-cols-2">
                {canSeeCosts && <Field label="Price per unit on the delivery (rand)" htmlFor={`p-${l.id}`}><Input id={`p-${l.id}`} inputMode="decimal" value={x.cost} onChange={(e) => set(l.id, { cost: e.target.value })} /></Field>}
                <Field label="Note" htmlFor={`n-${l.id}`}><Input id={`n-${l.id}`} value={x.notes} onChange={(e) => set(l.id, { notes: e.target.value })} placeholder="e.g. two boxes crushed" /></Field>
              </div>
              {!l.hasPart && <p className="text-xs text-muted">Not a catalogue part, so it is recorded on the order but does not change stock.</p>}
            </li>
          );
        })}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Delivery note / supplier reference" htmlFor="rc-ref"><Input id="rc-ref" name="deliveryNoteRef" maxLength={80} /></Field>
        {locations.length > 1 && <Field label="Received at" htmlFor="rc-loc"><select id="rc-loc" name="locationId" defaultValue={defaultLocationId} className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10">{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      </div>
      <Field label="Notes about the delivery" htmlFor="rc-notes"><Textarea id="rc-notes" name="notes" rows={2} /></Field>
      <p className="text-xs text-muted">After saving you can attach the delivery note or photos of damage to {number}.</p>
      <Button type="submit" loading={pending || !ready}>Save delivery</Button>
    </form>
  );
}
