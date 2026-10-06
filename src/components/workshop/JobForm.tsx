'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { CustomerPicker, VehiclePicker, type CustomerOption } from '@/components/workshop/Pickers';
import { api } from '@/lib/api-client';
import type { BookingLookups } from './BookingForm';

/** Open a job card for a customer and vehicle who are here now (a walk-in needs no booking). Arrival details are recorded as part of the same step. */
export function JobForm({
  lookups, customer: initialCustomer, vehicleId: initialVehicleId, requireSignature, perms, templates, priorityLabels,
}: {
  /** Ready-made job recipes (Settings, Services): picking one copies its labour, parts and checklist onto the new job. */
  templates?: { id: string; name: string }[];
  priorityLabels?: Record<string, string>;
  lookups: BookingLookups;
  customer?: CustomerOption | null;
  vehicleId?: string;
  requireSignature: boolean;
  perms: { createCustomer: boolean; createVehicle: boolean; assign: boolean };
}) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer ?? null);
  const [vehicleId, setVehicleId] = useState(initialVehicleId ?? '');
  const [v, setV] = useState({
    isWalkIn: true, serviceTypeId: '', serviceLabel: '', complaint: '', priority: 'NORMAL', mileageKm: '', fuelLevel: '', existingDamage: '', keysAccessories: '',
    vehicleCondition: '', signatureName: '', primaryTechnicianMembershipId: '', bayId: '', estimatedCompletionAt: '', templateId: '',
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  return (
    <form
      method="post"
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const res = await api<{ id: string }>(v.templateId ? '/api/v1/jobs/from-template' : '/api/v1/jobs', {
            body: { ...v, templateId: v.templateId || undefined, customerId: customer?.id ?? '', vehicleId, serviceLabel: v.serviceTypeId ? '' : v.serviceLabel, estimatedCompletionAt: v.estimatedCompletionAt ? new Date(v.estimatedCompletionAt).toISOString() : '' },
          });
          router.push(`/jobs/${res.data.id}`);
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Customer and vehicle</h2>
        <Field label="Customer" htmlFor="job-customer" error={fields.customerId}>
          <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setVehicleId(''); }} canCreate={perms.createCustomer} error={fields.customerId} />
        </Field>
        <Field label="Vehicle" htmlFor="job-vehicle" error={fields.vehicleId}>
          <VehiclePicker customerId={customer?.id ?? null} value={vehicleId} onChange={(id) => setVehicleId(id)} canCreate={perms.createVehicle} error={fields.vehicleId} />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={v.isWalkIn} onChange={set('isWalkIn')} /> This is a walk-in (no booking)</label>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">The job</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {templates && templates.length > 0 && (
            <Field label="Start from a template" htmlFor="job-template" hint="Copies the template's labour, parts and checklist onto this job.">
              <Select id="job-template" value={v.templateId} onChange={set('templateId')}><option value="">No template</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
            </Field>
          )}
          <Field label="Service" htmlFor="job-service">
            <Select id="job-service" value={v.serviceTypeId} onChange={set('serviceTypeId')}>
              <option value="">Other / not decided</option>{lookups.serviceTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          {!v.serviceTypeId && <Field label="What is it for?" htmlFor="job-label"><Input id="job-label" value={v.serviceLabel} onChange={set('serviceLabel')} /></Field>}
          <Field label="Priority" htmlFor="job-priority">
            <Select id="job-priority" value={v.priority} onChange={set('priority')}>{(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((p) => <option key={p} value={p}>{priorityLabels?.[p] ?? p.charAt(0) + p.slice(1).toLowerCase()}</option>)}</Select>
          </Field>
          <Field label="Estimated completion" htmlFor="job-eta" error={fields.estimatedCompletionAt}><Input id="job-eta" type="datetime-local" value={v.estimatedCompletionAt} onChange={set('estimatedCompletionAt')} /></Field>
          {perms.assign && (
            <Field label="Technician" htmlFor="job-tech" error={fields.primaryTechnicianMembershipId}>
              <Select id="job-tech" value={v.primaryTechnicianMembershipId} onChange={set('primaryTechnicianMembershipId')}>
                <option value="">Assign later</option>{lookups.technicians.map((t) => <option key={t.membershipId} value={t.membershipId}>{t.name}</option>)}
              </Select>
            </Field>
          )}
          {lookups.bays.length > 0 && (
            <Field label="Bay" htmlFor="job-bay"><Select id="job-bay" value={v.bayId} onChange={set('bayId')}><option value="">None</option>{lookups.bays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          )}
        </div>
        <Field label="Customer’s complaint or request" htmlFor="job-complaint" error={fields.complaint}><Textarea id="job-complaint" rows={3} value={v.complaint} onChange={set('complaint')} /></Field>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Check-in</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Odometer (km)" htmlFor="job-km" error={fields.mileageKm}><Input id="job-km" inputMode="numeric" value={v.mileageKm} onChange={set('mileageKm')} aria-invalid={!!fields.mileageKm} /></Field>
          <Field label="Fuel level" htmlFor="job-fuel">
            <Select id="job-fuel" value={v.fuelLevel} onChange={set('fuelLevel')}>
              <option value="">Not recorded</option><option value="EMPTY">Empty</option><option value="QUARTER">¼</option><option value="HALF">½</option><option value="THREE_QUARTERS">¾</option><option value="FULL">Full</option>
            </Select>
          </Field>
          <Field label="Keys and accessories" htmlFor="job-keys"><Input id="job-keys" value={v.keysAccessories} onChange={set('keysAccessories')} placeholder="1 key, spare wheel…" /></Field>
          <Field label={requireSignature ? 'Customer confirmation (their name) — required' : 'Customer confirmation (their name) — optional'} htmlFor="job-sign" error={fields.signatureName}><Input id="job-sign" value={v.signatureName} onChange={set('signatureName')} aria-invalid={!!fields.signatureName} /></Field>
        </div>
        <Field label="Existing damage" htmlFor="job-damage"><Textarea id="job-damage" rows={2} value={v.existingDamage} onChange={set('existingDamage')} /></Field>
        <Field label="Vehicle condition" htmlFor="job-cond"><Textarea id="job-cond" rows={2} value={v.vehicleCondition} onChange={set('vehicleCondition')} /></Field>
        <p className="text-xs text-muted">You can add check-in photos and a signature on the job card straight after.</p>
      </section>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={pending || !ready}>Open job card</Button>
      </div>
    </form>
  );
}
