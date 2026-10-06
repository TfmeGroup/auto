'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { CustomerPicker, VehiclePicker, type CustomerOption } from '@/components/workshop/Pickers';
import { api, ApiError } from '@/lib/api-client';

export interface BookingLookups {
  serviceTypes: { id: string; name: string; defaultDurationMin: number }[];
  bays: { id: string; name: string }[];
  technicians: { membershipId: string; name: string }[];
  locations: { id: string; name: string }[];
}

/**
 * New booking: customer and vehicle are chosen from existing records (or created on the spot), the service sets the
 * default duration, and free start times are suggested from the same rules the server enforces when you save.
 */
export function BookingForm({
  lookups, customer: initialCustomer, vehicleId: initialVehicleId, date: initialDate, perms, mode = 'booking', waitingEntryId,
}: {
  lookups: BookingLookups;
  customer?: CustomerOption | null;
  vehicleId?: string;
  date?: string;
  perms: { createCustomer: boolean; createVehicle: boolean; editDuration: boolean; manageCalendar: boolean };
  mode?: 'booking' | 'waiting-convert';
  waitingEntryId?: string;
}) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer ?? null);
  const [vehicleId, setVehicleId] = useState(initialVehicleId ?? '');
  const [serviceTypeId, setServiceTypeId] = useState('');
  const [serviceLabel, setServiceLabel] = useState('');
  const [duration, setDuration] = useState('60');
  const [date, setDate] = useState(initialDate ?? '');
  const [time, setTime] = useState('');
  const [technician, setTechnician] = useState('');
  const [bay, setBay] = useState('');
  const [location, setLocation] = useState('');
  const [customerNotes, setCustomerNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [outside, setOutside] = useState(false);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);

  const type = lookups.serviceTypes.find((t) => t.id === serviceTypeId);
  useEffect(() => { if (type) setDuration(String(type.defaultDurationMin)); }, [type]);
  // Choosing a different customer clears the vehicle: it belongs to the previous one.
  useEffect(() => {
    if (customer?.id !== initialCustomer?.id) setVehicleId('');
  }, [customer?.id, initialCustomer?.id]);

  useEffect(() => {
    const d = Number(duration);
    if (!date || !Number.isInteger(d) || d < 5) { setSlots(null); return; }
    let live = true;
    const q = new URLSearchParams({ date, durationMin: String(d), ...(technician ? { technicianId: technician } : {}), ...(bay ? { bayId: bay } : {}) });
    api<{ slots: string[] }>(`/api/v1/bookings/slots?${q}`).then((r) => { if (live) setSlots(r.data.slots); }).catch(() => { if (live) setSlots(null); });
    return () => { live = false; };
  }, [date, duration, technician, bay]);

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setConflicts([]);
        const body = {
          customerId: customer?.id ?? '', vehicleId, serviceTypeId, serviceLabel: serviceTypeId ? '' : serviceLabel, date, time,
          durationMin: perms.editDuration || !type || Number(duration) === type.defaultDurationMin ? duration : String(type.defaultDurationMin),
          technicianMembershipId: technician, bayId: bay, locationId: location, customerNotes, internalNotes, allowOutsideHours: outside,
        };
        void run(async () => {
          try {
            const res = mode === 'waiting-convert'
              ? await api<{ id: string }>(`/api/v1/bookings/waiting-list/${waitingEntryId}/convert`, { body })
              : await api<{ id: string }>('/api/v1/bookings', { body });
            router.push(`/bookings/${res.data.id}`);
            router.refresh();
          } catch (err) {
            if (err instanceof ApiError && err.code === 'CONFLICT') setConflicts([err.message]);
            throw err;
          }
        });
      }}
      className="space-y-5"
    >
      {error && <Alert>{error}</Alert>}
      {conflicts.length > 0 && <Alert tone="warn">{conflicts[0]} Pick another time, technician or bay.</Alert>}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Who and what</h2>
        <Field label="Customer" htmlFor="customer" error={fields.customerId}>
          <CustomerPicker value={customer} onChange={setCustomer} canCreate={perms.createCustomer} error={fields.customerId} />
        </Field>
        <Field label="Vehicle" htmlFor="vehicle" error={fields.vehicleId}>
          <VehiclePicker customerId={customer?.id ?? null} value={vehicleId} onChange={(id) => setVehicleId(id)} canCreate={perms.createVehicle} error={fields.vehicleId} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Service" htmlFor="service" error={fields.serviceTypeId}>
            <Select id="service" value={serviceTypeId} onChange={(e) => setServiceTypeId(e.target.value)} aria-invalid={!!fields.serviceTypeId}>
              <option value="">Other (type below)</option>
              {lookups.serviceTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.defaultDurationMin} min)</option>)}
            </Select>
          </Field>
          {!serviceTypeId && (
            <Field label="What is it for?" htmlFor="serviceLabel">
              <Input id="serviceLabel" value={serviceLabel} onChange={(e) => setServiceLabel(e.target.value)} />
            </Field>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">When</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date" htmlFor="date" error={fields.date}>
            <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={!!fields.date} />
          </Field>
          <Field label="Start time" htmlFor="time">
            <Input id="time" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Duration (minutes)" htmlFor="duration" error={fields.durationMin} hint={!perms.editDuration ? 'Set by the service.' : type ? `Service default: ${type.defaultDurationMin} min. Changing it here does not change the service.` : undefined}>
            <Input id="duration" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} disabled={!perms.editDuration && !!type} />
          </Field>
        </div>
        {date && slots && (
          <div aria-live="polite">
            {slots.length === 0 ? (
              <p className="text-sm text-warn">No free start times that day for this technician and duration.</p>
            ) : (
              <>
                <p className="mb-1.5 text-xs font-medium text-muted">Free start times</p>
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((s) => (
                    <button key={s} type="button" onClick={() => setTime(s)} aria-pressed={time === s} className={`min-h-10 rounded-lg border px-3 text-sm font-medium ${time === s ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line bg-surface hover:bg-canvas'}`}>{s}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Technician" htmlFor="technician" error={fields.technicianMembershipId}>
            <Select id="technician" value={technician} onChange={(e) => setTechnician(e.target.value)}>
              <option value="">Not assigned yet</option>
              {lookups.technicians.map((t) => <option key={t.membershipId} value={t.membershipId}>{t.name}</option>)}
            </Select>
          </Field>
          {lookups.bays.length > 0 && (
            <Field label="Bay" htmlFor="bay" error={fields.bayId}>
              <Select id="bay" value={bay} onChange={(e) => setBay(e.target.value)}>
                <option value="">Any / none</option>
                {lookups.bays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          )}
          {lookups.locations.length > 1 && (
            <Field label="Location" htmlFor="location">
              <Select id="location" value={location} onChange={(e) => setLocation(e.target.value)}>
                <option value="">Default</option>
                {lookups.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
        {perms.manageCalendar && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} className="size-5" />
            Book outside opening hours or technician hours (I know it is outside)
          </label>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer’s notes" htmlFor="customerNotes" hint="What the customer asked for. Carried onto the job card.">
          <Textarea id="customerNotes" value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} />
        </Field>
        <Field label="Internal notes" htmlFor="internalNotes" hint="Only your team sees this.">
          <Textarea id="internalNotes" value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
        </Field>
      </section>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={pending || !ready}>{mode === 'waiting-convert' ? 'Book this customer in' : 'Create booking'}</Button>
      </div>
    </form>
  );
}
