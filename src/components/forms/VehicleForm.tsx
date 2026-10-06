'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { CustomerPicker, type CustomerOption } from '@/components/workshop/Pickers';
import { api } from '@/lib/api-client';

export interface VehicleFormValues {
  id?: string;
  registration?: string | null;
  vin?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  variant?: string | null;
  colour?: string | null;
  engine?: string | null;
  engineSizeCc?: number | null;
  fuelType?: string | null;
  transmission?: string | null;
  driveType?: string | null;
  mileageKm?: number | null;
  notes?: string | null;
}

const TEXT = ['registration', 'vin', 'make', 'model', 'year', 'variant', 'colour', 'engine', 'engineSizeCc', 'fuelType', 'transmission', 'driveType', 'notes'] as const;

export function VehicleForm({
  initial = {}, customer: initialCustomer, canCreateCustomer = false, canSubmit = true,
}: {
  initial?: VehicleFormValues;
  customer?: CustomerOption | null;
  canCreateCustomer?: boolean;
  canSubmit?: boolean;
}) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const editing = !!initial.id;
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer ?? null);

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const body: Record<string, string> = { customerId: customer?.id ?? '' };
        for (const f of TEXT) body[f] = formValue(form, f);
        if (!editing) body.mileageKm = formValue(form, 'mileageKm');
        void run(async () => {
          const res = editing
            ? await api<{ id: string }>(`/api/v1/vehicles/${initial.id}`, { method: 'PATCH', body })
            : await api<{ id: string }>('/api/v1/vehicles', { body });
          router.push(`/vehicles/${res.data.id}`);
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      {error && <Alert>{error}</Alert>}
      <Field label={editing ? 'Owner' : 'Customer (owner)'} htmlFor="customer" error={fields.customerId} hint={editing ? 'Choosing a different customer moves the vehicle to them; the history is kept.' : undefined}>
        <CustomerPicker value={customer} onChange={setCustomer} canCreate={canCreateCustomer} error={fields.customerId} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Registration" htmlFor="registration" error={fields.registration}>
          <Input id="registration" name="registration" defaultValue={initial.registration ?? ''} autoCapitalize="characters" autoComplete="off" aria-invalid={!!fields.registration} />
        </Field>
        <Field label="VIN" htmlFor="vin" error={fields.vin}>
          <Input id="vin" name="vin" defaultValue={initial.vin ?? ''} autoCapitalize="characters" autoComplete="off" aria-invalid={!!fields.vin} />
        </Field>
        <Field label="Make" htmlFor="make"><Input id="make" name="make" defaultValue={initial.make ?? ''} /></Field>
        <Field label="Model" htmlFor="model"><Input id="model" name="model" defaultValue={initial.model ?? ''} /></Field>
        <Field label="Year" htmlFor="year" error={fields.year}><Input id="year" name="year" inputMode="numeric" defaultValue={initial.year ?? ''} aria-invalid={!!fields.year} /></Field>
        <Field label="Colour" htmlFor="colour"><Input id="colour" name="colour" defaultValue={initial.colour ?? ''} /></Field>
        {!editing && (
          <Field label="Current mileage (km)" htmlFor="mileageKm" error={fields.mileageKm}>
            <Input id="mileageKm" name="mileageKm" inputMode="numeric" defaultValue="" aria-invalid={!!fields.mileageKm} />
          </Field>
        )}
      </div>
      <details open={!!(initial.variant || initial.engine || initial.fuelType || initial.transmission || initial.driveType || initial.notes)} className="rounded-lg border border-line px-3 py-2">
        <summary className="min-h-10 cursor-pointer text-sm font-semibold leading-10">More details (optional)</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Variant" htmlFor="variant"><Input id="variant" name="variant" defaultValue={initial.variant ?? ''} /></Field>
          <Field label="Engine" htmlFor="engine"><Input id="engine" name="engine" defaultValue={initial.engine ?? ''} /></Field>
          <Field label="Engine size (cc)" htmlFor="engineSizeCc" error={fields.engineSizeCc}><Input id="engineSizeCc" name="engineSizeCc" inputMode="numeric" defaultValue={initial.engineSizeCc ?? ''} /></Field>
          <Field label="Fuel type" htmlFor="fuelType">
            <Select id="fuelType" name="fuelType" defaultValue={initial.fuelType ?? ''}>
              <option value="">Not set</option><option value="PETROL">Petrol</option><option value="DIESEL">Diesel</option><option value="HYBRID">Hybrid</option><option value="ELECTRIC">Electric</option><option value="LPG">LPG</option><option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field label="Transmission" htmlFor="transmission">
            <Select id="transmission" name="transmission" defaultValue={initial.transmission ?? ''}>
              <option value="">Not set</option><option value="MANUAL">Manual</option><option value="AUTOMATIC">Automatic</option><option value="CVT">CVT</option><option value="DCT">DCT</option><option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field label="Drive type" htmlFor="driveType">
            <Select id="driveType" name="driveType" defaultValue={initial.driveType ?? ''}>
              <option value="">Not set</option><option value="FWD">Front-wheel drive</option><option value="RWD">Rear-wheel drive</option><option value="AWD">All-wheel drive</option><option value="FOUR_BY_FOUR">4x4</option><option value="OTHER">Other</option>
            </Select>
          </Field>
        </div>
        <div className="mt-3"><Field label="Notes" htmlFor="notes"><Textarea id="notes" name="notes" defaultValue={initial.notes ?? ''} /></Field></div>
      </details>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={pending || !ready} disabled={!canSubmit}>{editing ? 'Save changes' : 'Add vehicle'}</Button>
      </div>
    </form>
  );
}
