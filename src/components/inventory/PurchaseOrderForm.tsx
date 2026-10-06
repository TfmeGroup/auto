'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { PartPicker, type PickedPart } from './PartPicker';
import { centsToRand, money, newLineKey, randToCentsOrNull, type MoneyFmt } from './shared';

export interface PoLineDraft { key: string; partId: string | null; label: string; description: string; supplierPartNumber: string; quantity: string; costRand: string; taxTreatment: string }
export interface PoDefaults { id?: string; supplierId?: string; locationId?: string; poDate?: string; expectedDate?: string | null; notes?: string | null; internalNotes?: string | null; terms?: string | null; lines?: PoLineDraft[] }

export function PurchaseOrderForm({
  mode, suppliers, locations, defaults = {}, fmt, vat,
}: {
  mode: 'create' | 'edit';
  suppliers: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  defaults?: PoDefaults;
  fmt: MoneyFmt;
  vat: { registered: boolean; rateBps: number };
}) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [lines, setLines] = useState<PoLineDraft[]>(defaults.lines ?? []);
  const [adding, setAdding] = useState(defaults.lines?.length ? false : true);
  const [bad, setBad] = useState<string | null>(null);

  const setLine = (key: string, patch: Partial<PoLineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pick = (p: PickedPart) => {
    setLines((ls) => [...ls, { key: newLineKey(), partId: p.id, label: `${p.sku} — ${p.name}`, description: '', supplierPartNumber: '', quantity: '1', costRand: centsToRand(p.costCents), taxTreatment: p.taxTreatment }]);
    setAdding(false);
  };

  // A preview only: the server prices the order again and ignores these numbers.
  const parsed = lines.map((l) => ({ qty: Number(l.quantity), cost: randToCentsOrNull(l.costRand), tax: l.taxTreatment }));
  const sub = parsed.reduce((s, l) => s + (Number.isFinite(l.qty) && typeof l.cost === 'number' ? l.qty * l.cost : 0), 0);
  const vatTotal = vat.registered ? parsed.reduce((s, l) => s + (l.tax === 'STANDARD' && Number.isFinite(l.qty) && typeof l.cost === 'number' ? Math.round((l.qty * l.cost * vat.rateBps) / 10_000) : 0), 0) : 0;

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBad(null);
        const f = e.currentTarget;
        const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
        const payload = lines.map((l) => ({ partId: l.partId ?? '', description: l.description || (l.partId ? '' : ''), supplierPartNumber: l.supplierPartNumber, quantity: l.quantity, unitCostCents: randToCentsOrNull(l.costRand), taxTreatment: l.taxTreatment }));
        if (payload.some((l) => typeof l.unitCostCents !== 'number')) { setBad('Enter every unit cost as an amount, like 125.50.'); return; }
        void run(async () => {
          const body = { supplierId: v('supplierId'), locationId: v('locationId'), poDate: v('poDate') || undefined, expectedDate: v('expectedDate'), notes: v('notes'), internalNotes: v('internalNotes'), terms: v('terms'), lines: payload };
          const r = await api<{ id: string }>(mode === 'create' ? '/api/v1/purchase-orders' : `/api/v1/purchase-orders/${defaults.id}`, { method: mode === 'create' ? 'POST' : 'PATCH', body });
          router.push(`/purchase-orders/${r.data.id ?? defaults.id}`);
          router.refresh();
        });
      }}
    >
      {(bad || error) && <Alert>{bad ?? error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier" htmlFor="po-sup" error={fields.supplierId}>
          <Select id="po-sup" name="supplierId" defaultValue={defaults.supplierId ?? ''} required aria-invalid={!!fields.supplierId}><option value="">Choose a supplier…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        </Field>
        <Field label="Deliver to" htmlFor="po-loc" error={fields.locationId}>
          <Select id="po-loc" name="locationId" defaultValue={defaults.locationId ?? locations[0]?.id ?? ''}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
        </Field>
        <Field label="Order date" htmlFor="po-date" error={fields.poDate}><Input id="po-date" name="poDate" type="date" defaultValue={defaults.poDate} /></Field>
        <Field label="Expected delivery" htmlFor="po-exp" error={fields.expectedDate}><Input id="po-exp" name="expectedDate" type="date" defaultValue={defaults.expectedDate ?? ''} /></Field>
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Lines</h2>
        {fields.lines && <p role="alert" className="text-xs font-medium text-danger">{fields.lines}</p>}
        {lines.length === 0 && <p className="text-sm text-muted">No lines yet. Add the parts you are ordering.</p>}
        <ul className="space-y-2">
          {lines.map((l) => (
            <li key={l.key} className="space-y-2 rounded-xl border border-line bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                {l.partId ? <p className="min-w-0 truncate text-sm font-semibold">{l.label}</p> : <Input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Description (a part that is not in your catalogue)" aria-label="Description" />}
                <Button type="button" variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove</Button>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                <Field label="Quantity" htmlFor={`q-${l.key}`}><Input id={`q-${l.key}`} inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></Field>
                <Field label="Unit cost (rand)" htmlFor={`c-${l.key}`}><Input id={`c-${l.key}`} inputMode="decimal" value={l.costRand} onChange={(e) => setLine(l.key, { costRand: e.target.value })} /></Field>
                {vat.registered && <Field label="VAT" htmlFor={`t-${l.key}`}><Select id={`t-${l.key}`} value={l.taxTreatment} onChange={(e) => setLine(l.key, { taxTreatment: e.target.value })}><option value="STANDARD">Standard</option><option value="ZERO_RATED">Zero rated</option><option value="EXEMPT">Exempt</option></Select></Field>}
                <Field label="Supplier part no." htmlFor={`s-${l.key}`}><Input id={`s-${l.key}`} value={l.supplierPartNumber} onChange={(e) => setLine(l.key, { supplierPartNumber: e.target.value })} /></Field>
              </div>
            </li>
          ))}
        </ul>
        {adding ? (
          <div className="space-y-2 rounded-xl border border-dashed border-line p-3">
            <PartPicker onPick={pick} allowScan placeholder="Search your catalogue to add a part" />
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => { setLines((ls) => [...ls, { key: newLineKey(), partId: null, label: '', description: '', supplierPartNumber: '', quantity: '1', costRand: '', taxTreatment: 'STANDARD' }]); setAdding(false); }}>Add a line that is not in the catalogue</Button>
              {lines.length > 0 && <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Done</Button>}
            </div>
          </div>
        ) : <Button type="button" variant="secondary" onClick={() => setAdding(true)}>Add another part</Button>}
      </section>

      <div className="ml-auto max-w-xs space-y-1 rounded-xl border border-line bg-canvas p-3 text-sm">
        <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="tabular-nums">{money(sub, fmt)}</span></div>
        {vat.registered && <div className="flex justify-between"><span className="text-muted">VAT</span><span className="tabular-nums">{money(vatTotal, fmt)}</span></div>}
        <div className="flex justify-between border-t border-line pt-1 font-bold"><span>Total</span><span className="tabular-nums">{money(sub + vatTotal, fmt)}</span></div>
        <p className="text-xs text-muted">Shown as a guide. The server works out the real totals.</p>
      </div>

      <Field label="Notes for the supplier" htmlFor="po-notes"><Textarea id="po-notes" name="notes" defaultValue={defaults.notes ?? ''} rows={2} /></Field>
      <Field label="Terms" htmlFor="po-terms"><Textarea id="po-terms" name="terms" defaultValue={defaults.terms ?? ''} rows={2} /></Field>
      <Field label="Internal notes (not sent to the supplier)" htmlFor="po-int"><Textarea id="po-int" name="internalNotes" defaultValue={defaults.internalNotes ?? ''} rows={2} /></Field>
      <div className="flex gap-2">
        <Button type="submit" loading={pending || !ready} disabled={lines.length === 0}>{mode === 'create' ? 'Save draft order' : 'Save changes'}</Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
