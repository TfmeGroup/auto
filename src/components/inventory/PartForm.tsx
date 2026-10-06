'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { categoryOptions, centsToRand, randToCentsOrNull, type CategoryOption } from './shared';

export type { CategoryOption };
export interface SupplierOption { id: string; name: string }
export interface LocationOption { id: string; name: string }

export interface PartDefaults {
  id?: string;
  sku?: string;
  partNumber?: string | null;
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  barcode?: string | null;
  unit?: string;
  costCents?: number | null;
  sellPriceCents?: number | null;
  taxTreatment?: string;
  minStock?: number;
  reorderLevel?: number | null;
  reorderQuantity?: number | null;
  primarySupplierId?: string | null;
  notes?: string | null;
}

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

export function PartForm({
  mode, defaults = {}, categories, suppliers, locations, canSeeCosts, canAdjust,
}: {
  mode: 'create' | 'edit';
  defaults?: PartDefaults;
  categories: CategoryOption[];
  suppliers: SupplierOption[];
  locations: LocationOption[];
  canSeeCosts: boolean;
  canAdjust: boolean;
}) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [priceTouched, setPriceTouched] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  const cats = categoryOptions(categories);

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBad(null);
        const f = e.currentTarget;
        const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
        const body: Record<string, unknown> = {
          sku: v('sku'), partNumber: v('partNumber'), name: v('name'), description: v('description'), categoryId: v('categoryId'), brand: v('brand'), manufacturer: v('manufacturer'),
          barcode: v('barcode'), unit: v('unit') || 'each', taxTreatment: v('taxTreatment') || 'STANDARD', minStock: v('minStock') || '0', reorderLevel: v('reorderLevel'), reorderQuantity: v('reorderQuantity'),
          primarySupplierId: v('primarySupplierId'), notes: v('notes'),
        };
        const sell = randToCentsOrNull(v('sellRand'));
        if (sell === undefined) { setBad('Enter amounts as numbers, like 450 or 450.50.'); return; }
        body.sellPriceCents = sell;
        if (canSeeCosts) {
          const cost = randToCentsOrNull(v('costRand'));
          if (cost === undefined) { setBad('Enter amounts as numbers, like 450 or 450.50.'); return; }
          body.costCents = cost;
        }
        if (mode === 'create') {
          if (canAdjust) { body.openingQuantity = v('openingQuantity'); body.openingLocationId = v('openingLocationId'); }
          body.bin = v('bin'); body.storageArea = v('storageArea');
        } else if (priceTouched) body.reason = v('reason');
        void run(async () => {
          const res = await api<{ id: string }>(mode === 'create' ? '/api/v1/inventory/parts' : `/api/v1/inventory/parts/${defaults.id}`, { method: mode === 'create' ? 'POST' : 'PATCH', body });
          router.push(`/inventory/parts/${res.data.id ?? defaults.id}`);
          router.refresh();
        });
      }}
    >
      {(bad || error) && <Alert>{bad ?? error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="pf-name" error={fields.name}><Input id="pf-name" name="name" required defaultValue={defaults.name} aria-invalid={!!fields.name} /></Field>
        <Field label="SKU" htmlFor="pf-sku" error={fields.sku} hint={mode === 'create' ? 'Leave blank to generate one.' : undefined}><Input id="pf-sku" name="sku" defaultValue={defaults.sku} aria-invalid={!!fields.sku} autoCapitalize="characters" /></Field>
        <Field label="Part number" htmlFor="pf-pn" error={fields.partNumber}><Input id="pf-pn" name="partNumber" defaultValue={str(defaults.partNumber)} /></Field>
        <Field label="Barcode" htmlFor="pf-bc" error={fields.barcode}><Input id="pf-bc" name="barcode" defaultValue={str(defaults.barcode)} inputMode="numeric" /></Field>
        <Field label="Category" htmlFor="pf-cat" error={fields.categoryId}>
          <Select id="pf-cat" name="categoryId" defaultValue={str(defaults.categoryId)}><option value="">No category</option>{cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
        </Field>
        <Field label="Brand" htmlFor="pf-brand"><Input id="pf-brand" name="brand" defaultValue={str(defaults.brand)} /></Field>
        <Field label="Manufacturer" htmlFor="pf-man"><Input id="pf-man" name="manufacturer" defaultValue={str(defaults.manufacturer)} /></Field>
        <Field label="Unit" htmlFor="pf-unit" hint="each, set, litre, kit…"><Input id="pf-unit" name="unit" defaultValue={defaults.unit ?? 'each'} /></Field>
      </div>
      <Field label="Description" htmlFor="pf-desc"><Textarea id="pf-desc" name="description" defaultValue={str(defaults.description)} /></Field>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Pricing</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {canSeeCosts && <Field label="Cost price (rand)" htmlFor="pf-cost" error={fields.costCents} hint="What one unit costs you."><Input id="pf-cost" name="costRand" inputMode="decimal" defaultValue={centsToRand(defaults.costCents)} onChange={() => setPriceTouched(true)} /></Field>}
          <Field label="Selling price (rand)" htmlFor="pf-sell" error={fields.sellPriceCents}><Input id="pf-sell" name="sellRand" inputMode="decimal" defaultValue={centsToRand(defaults.sellPriceCents)} onChange={() => setPriceTouched(true)} /></Field>
          <Field label="VAT" htmlFor="pf-vat">
            <Select id="pf-vat" name="taxTreatment" defaultValue={defaults.taxTreatment ?? 'STANDARD'}><option value="STANDARD">Standard rate</option><option value="ZERO_RATED">Zero rated</option><option value="EXEMPT">Exempt</option></Select>
          </Field>
        </div>
        {mode === 'edit' && priceTouched && <Field label="Reason for the price change (optional)" htmlFor="pf-reason"><Input id="pf-reason" name="reason" maxLength={200} /></Field>}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Stock levels</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Minimum stock" htmlFor="pf-min" error={fields.minStock}><Input id="pf-min" name="minStock" inputMode="numeric" defaultValue={str(defaults.minStock ?? 0)} /></Field>
          <Field label="Reorder level" htmlFor="pf-rl" hint="Optional. Counts as low at or below this."><Input id="pf-rl" name="reorderLevel" inputMode="numeric" defaultValue={str(defaults.reorderLevel)} /></Field>
          <Field label="Reorder quantity" htmlFor="pf-rq" hint="Optional. Suggested order size."><Input id="pf-rq" name="reorderQuantity" inputMode="numeric" defaultValue={str(defaults.reorderQuantity)} /></Field>
        </div>
        <Field label="Main supplier" htmlFor="pf-sup" error={fields.primarySupplierId}>
          <Select id="pf-sup" name="primarySupplierId" defaultValue={str(defaults.primarySupplierId)}><option value="">None</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        </Field>
        {mode === 'create' && (
          <div className="grid gap-3 sm:grid-cols-2">
            {canAdjust && <Field label="Opening stock" htmlFor="pf-open" error={fields.openingQuantity} hint="How many are on the shelf now. Recorded as an opening-balance adjustment."><Input id="pf-open" name="openingQuantity" inputMode="numeric" /></Field>}
            {canAdjust && locations.length > 1 && (
              <Field label="Where is it?" htmlFor="pf-loc"><Select id="pf-loc" name="openingLocationId">{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
            )}
            <Field label="Bin" htmlFor="pf-bin"><Input id="pf-bin" name="bin" placeholder="A12" /></Field>
            <Field label="Storage area" htmlFor="pf-area"><Input id="pf-area" name="storageArea" placeholder="Main store" /></Field>
          </div>
        )}
      </fieldset>
      <Field label="Notes" htmlFor="pf-notes"><Textarea id="pf-notes" name="notes" defaultValue={str(defaults.notes)} /></Field>
      <div className="flex gap-2">
        <Button type="submit" loading={pending || !ready}>{mode === 'create' ? 'Add part' : 'Save changes'}</Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
