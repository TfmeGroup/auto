'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { InlineForm } from '@/components/forms/InlineForm';
import { useSubmit } from '@/components/forms/use-submit';
import { CustomerPicker, VehiclePicker, type CustomerOption } from '@/components/workshop/Pickers';
import { api } from '@/lib/api-client';
import type { BookingLookups } from './BookingForm';

const FUEL = [
  { value: '', label: 'Not recorded' }, { value: 'EMPTY', label: 'Empty' }, { value: 'QUARTER', label: '¼' }, { value: 'HALF', label: '½' }, { value: 'THREE_QUARTERS', label: '¾' }, { value: 'FULL', label: 'Full' },
];

/** Check a booking in: opens its job (or goes to the one that already exists) with the vehicle's arrival details. */
export function BookingCheckIn({ bookingId, requireSignature, currentMileage }: { bookingId: string; requireSignature: boolean; currentMileage: number | null }) {
  const router = useRouter();
  return (
    <InlineForm
      endpoint={`/api/v1/bookings/${bookingId}/check-in`}
      submitLabel="Check in and open the job"
      resetOnSuccess={false}
      refresh={false}
      onDone={(job) => router.push(`/jobs/${(job as { id: string }).id}`)}
      fields={[
        { name: 'mileageKm', label: 'Odometer (km)', type: 'number', hint: currentMileage !== null ? `Last recorded ${currentMileage.toLocaleString('en-ZA')} km` : undefined },
        { name: 'fuelLevel', label: 'Fuel level', type: 'select', options: FUEL },
        { name: 'keysAccessories', label: 'Keys and accessories', placeholder: '1 key, spare wheel, jack…', span: 'full' },
        { name: 'existingDamage', label: 'Existing damage', type: 'textarea', rows: 2, span: 'full' },
        { name: 'vehicleCondition', label: 'Vehicle condition', type: 'textarea', rows: 2, span: 'full' },
        { name: 'signatureName', label: requireSignature ? 'Customer confirmation (their name) — required' : 'Customer confirmation (their name) — optional', required: requireSignature, span: 'full', hint: 'The customer confirms the condition recorded above.' },
      ]}
    />
  );
}

export function WaitingForm({ lookups, perms }: { lookups: BookingLookups; perms: { createCustomer: boolean; createVehicle: boolean } }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [vehicleId, setVehicleId] = useState('');
  const [v, setV] = useState({ serviceTypeId: '', serviceLabel: '', preferredDate: '', preferredFrom: '', preferredTo: '', contactPreference: '', notes: '' });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <form
      method="post" noValidate className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api('/api/v1/bookings/waiting-list', { body: { ...v, customerId: customer?.id ?? '', vehicleId, serviceLabel: v.serviceTypeId ? '' : v.serviceLabel } });
          setCustomer(null); setVehicleId(''); setV({ serviceTypeId: '', serviceLabel: '', preferredDate: '', preferredFrom: '', preferredTo: '', contactPreference: '', notes: '' });
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <Field label="Customer" htmlFor="w-customer" error={fields.customerId}><CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setVehicleId(''); }} canCreate={perms.createCustomer} error={fields.customerId} /></Field>
      <Field label="Vehicle" htmlFor="w-vehicle" error={fields.vehicleId}><VehiclePicker customerId={customer?.id ?? null} value={vehicleId} onChange={(id) => setVehicleId(id)} canCreate={perms.createVehicle} error={fields.vehicleId} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Service wanted" htmlFor="w-service" error={fields.serviceTypeId}>
          <Select id="w-service" value={v.serviceTypeId} onChange={set('serviceTypeId')}>
            <option value="">Other (type below)</option>{lookups.serviceTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        {!v.serviceTypeId && <Field label="What is it for?" htmlFor="w-label"><Input id="w-label" value={v.serviceLabel} onChange={set('serviceLabel')} /></Field>}
        <Field label="Preferred date" htmlFor="w-date" error={fields.preferredDate}><Input id="w-date" type="date" value={v.preferredDate} onChange={set('preferredDate')} /></Field>
        <Field label="Contact by" htmlFor="w-contact">
          <Select id="w-contact" value={v.contactPreference} onChange={set('contactPreference')}>
            <option value="">No preference</option><option value="PHONE">Phone call</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option><option value="EMAIL">Email</option>
          </Select>
        </Field>
        <Field label="Free from" htmlFor="w-from" error={fields.preferredFrom}><Input id="w-from" type="time" value={v.preferredFrom} onChange={set('preferredFrom')} /></Field>
        <Field label="Free until" htmlFor="w-to" error={fields.preferredTo}><Input id="w-to" type="time" value={v.preferredTo} onChange={set('preferredTo')} /></Field>
      </div>
      <Field label="Notes" htmlFor="w-notes"><Textarea id="w-notes" value={v.notes} onChange={set('notes')} /></Field>
      <Button type="submit" loading={pending || !ready}>Add to waiting list</Button>
    </form>
  );
}

export function RecurringForm({ lookups, perms }: { lookups: BookingLookups; perms: { createCustomer: boolean; createVehicle: boolean } }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [vehicleId, setVehicleId] = useState('');
  const [v, setV] = useState({ serviceTypeId: '', serviceLabel: '', technicianMembershipId: '', frequency: 'WEEKLY', intervalCount: '1', startDate: '', time: '09:00', durationMin: '', endDate: '', occurrences: '' });
  const [result, setResult] = useState<{ created: number; skipped: { date: string; reasons: string[] }[] } | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <form
      method="post" noValidate className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setResult(null);
        void run(async () => {
          const r = await api<{ created: unknown[]; skipped: { date: string; reasons: string[] }[] }>('/api/v1/bookings/recurring', { body: { ...v, customerId: customer?.id ?? '', vehicleId, serviceLabel: v.serviceTypeId ? '' : v.serviceLabel } });
          setResult({ created: r.data.created.length, skipped: r.data.skipped });
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {result && (
        <Alert tone={result.skipped.length ? 'warn' : 'ok'}>
          {result.created} booking{result.created === 1 ? '' : 's'} created.
          {result.skipped.length > 0 && <ul className="mt-1 list-disc pl-5">{result.skipped.map((s) => <li key={s.date}>{s.date}: {s.reasons[0]} (not booked)</li>)}</ul>}
        </Alert>
      )}
      <Field label="Customer" htmlFor="r-customer" error={fields.customerId}><CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setVehicleId(''); }} canCreate={perms.createCustomer} error={fields.customerId} /></Field>
      <Field label="Vehicle" htmlFor="r-vehicle" error={fields.vehicleId}><VehiclePicker customerId={customer?.id ?? null} value={vehicleId} onChange={(id) => setVehicleId(id)} canCreate={perms.createVehicle} error={fields.vehicleId} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Service" htmlFor="r-service"><Select id="r-service" value={v.serviceTypeId} onChange={set('serviceTypeId')}><option value="">Other (type below)</option>{lookups.serviceTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        {!v.serviceTypeId && <Field label="What is it for?" htmlFor="r-label" error={fields.serviceTypeId}><Input id="r-label" value={v.serviceLabel} onChange={set('serviceLabel')} /></Field>}
        <Field label="Preferred technician" htmlFor="r-tech"><Select id="r-tech" value={v.technicianMembershipId} onChange={set('technicianMembershipId')}><option value="">None</option>{lookups.technicians.map((t) => <option key={t.membershipId} value={t.membershipId}>{t.name}</option>)}</Select></Field>
        <Field label="Repeats" htmlFor="r-freq"><Select id="r-freq" value={v.frequency} onChange={set('frequency')}><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></Select></Field>
        <Field label="Every (weeks/months)" htmlFor="r-int" error={fields.intervalCount}><Input id="r-int" inputMode="numeric" value={v.intervalCount} onChange={set('intervalCount')} /></Field>
        <Field label="Duration (min, optional)" htmlFor="r-dur" error={fields.durationMin}><Input id="r-dur" inputMode="numeric" value={v.durationMin} onChange={set('durationMin')} /></Field>
        <Field label="First date" htmlFor="r-start" error={fields.startDate}><Input id="r-start" type="date" value={v.startDate} onChange={set('startDate')} /></Field>
        <Field label="Time" htmlFor="r-time" error={fields.time}><Input id="r-time" type="time" value={v.time} onChange={set('time')} /></Field>
        <div />
        <Field label="Ends on (date)" htmlFor="r-end" error={fields.endDate}><Input id="r-end" type="date" value={v.endDate} onChange={set('endDate')} /></Field>
        <Field label="…or after this many" htmlFor="r-occ" error={fields.occurrences} hint="Set one of the two. Up to 104."><Input id="r-occ" inputMode="numeric" value={v.occurrences} onChange={set('occurrences')} /></Field>
      </div>
      <p className="text-xs text-muted">Each date becomes its own booking, checked against the same availability rules. Dates that cannot be booked are skipped and listed.</p>
      <Button type="submit" loading={pending || !ready}>Create the series</Button>
    </form>
  );
}
