'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

/**
 * Customer and vehicle pickers used by every booking and job form. Both search on the server as you type and both
 * can create the missing record in place ("quick create"), so nobody has to leave a half-filled form to add one.
 */

export interface CustomerOption { id: string; name: string; customerNumber: string; mobile: string | null; email?: string | null }
export interface VehicleOption { id: string; registration: string | null; make: string | null; model: string | null; mileageKm: number | null; customerId?: string }

const vehicleText = (v: VehicleOption) => [v.registration, [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Vehicle';

export function CustomerPicker({
  value, onChange, canCreate, error,
}: {
  value: CustomerOption | null;
  onChange: (c: CustomerOption | null) => void;
  canCreate: boolean;
  error?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (value) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<CustomerOption[]>(`/api/v1/customers?pageSize=8&sort=name&dir=asc${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
        if (mine === seq.current) setResults(r.data);
      } catch {
        if (mine === seq.current) setResults([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{value.name}</p>
          <p className="truncate text-xs text-muted">{[value.customerNumber, value.mobile].filter(Boolean).join(' · ')}</p>
        </div>
        <Button type="button" variant="ghost" onClick={() => onChange(null)}>Change</Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Input type="search" placeholder="Search name, phone, email or number" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} aria-invalid={!!error} autoComplete="off" />
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface" aria-busy={loading}>
        {results.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onChange(c)} className="flex min-h-12 w-full flex-col items-start justify-center px-3 py-2 text-left hover:bg-canvas">
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs text-muted">{[c.customerNumber, c.mobile].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
        {!loading && results.length === 0 && <li className="px-3 py-3 text-sm text-muted">No customers match.</li>}
      </ul>
      {canCreate && !creating && <Button type="button" variant="secondary" onClick={() => setCreating(true)}>Add a new customer</Button>}
      {creating && <QuickCustomer initialName={q} onCancel={() => setCreating(false)} onCreated={(c) => { setCreating(false); onChange(c); }} />}
    </div>
  );
}

function QuickCustomer({ initialName, onCancel, onCreated }: { initialName: string; onCancel: () => void; onCreated: (c: CustomerOption) => void }) {
  const [first, ...rest] = initialName.trim().split(/\s+/);
  const [v, setV] = useState({ firstName: first && !/\d/.test(first) ? first : '', lastName: rest.join(' '), mobile: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function save() {
    setBusy(true); setErr(null); setFields({});
    try {
      const r = await api<CustomerOption>('/api/v1/customers', { body: v });
      onCreated(r.data);
    } catch (e) {
      if (e instanceof ApiError) { setFields(e.fields); setErr(Object.keys(e.fields).length ? 'Please fix the highlighted fields.' : e.message); } else setErr('Could not reach the server.');
    } finally { setBusy(false); }
  }
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <div className="space-y-2 rounded-lg border border-line bg-canvas p-3" role="group" aria-label="New customer">
      {err && <Alert>{err}</Alert>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div><Input placeholder="First name" aria-label="First name" value={v.firstName} onChange={set('firstName')} aria-invalid={!!fields.firstName} />{fields.firstName && <p className="mt-1 text-xs text-danger">{fields.firstName}</p>}</div>
        <div><Input placeholder="Last name" aria-label="Last name" value={v.lastName} onChange={set('lastName')} aria-invalid={!!fields.lastName} />{fields.lastName && <p className="mt-1 text-xs text-danger">{fields.lastName}</p>}</div>
        <div><Input placeholder="Mobile number" aria-label="Mobile number" type="tel" inputMode="tel" value={v.mobile} onChange={set('mobile')} aria-invalid={!!fields.mobile} />{fields.mobile && <p className="mt-1 text-xs text-danger">{fields.mobile}</p>}</div>
        <div><Input placeholder="Email (optional)" aria-label="Email" type="email" inputMode="email" value={v.email} onChange={set('email')} aria-invalid={!!fields.email} />{fields.email && <p className="mt-1 text-xs text-danger">{fields.email}</p>}</div>
      </div>
      <div className="flex gap-2">
        <Button type="button" loading={busy} onClick={save}>Save customer</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function VehiclePicker({
  customerId, value, onChange, canCreate, error,
}: {
  customerId: string | null;
  value: string;
  onChange: (id: string, v?: VehicleOption) => void;
  canCreate: boolean;
  error?: string;
}) {
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!customerId) { setVehicles([]); return; }
    let live = true;
    setLoading(true);
    api<VehicleOption[]>(`/api/v1/vehicles?customerId=${customerId}&pageSize=50&sort=registration&dir=asc`)
      .then((r) => { if (live) { setVehicles(r.data); if (r.data.length === 1 && !value) onChange(r.data[0]!.id, r.data[0]); } })
      .catch(() => { if (live) setVehicles([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  if (!customerId) return <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted">Choose the customer first.</p>;
  return (
    <div className="space-y-2">
      <Select aria-label="Vehicle" value={value} onChange={(e) => onChange(e.target.value, vehicles.find((v) => v.id === e.target.value))} aria-invalid={!!error} aria-busy={loading} disabled={loading}>
        <option value="">{loading ? 'Loading vehicles…' : vehicles.length ? 'Choose a vehicle' : 'This customer has no vehicles yet'}</option>
        {vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleText(v)}</option>)}
      </Select>
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      {canCreate && !creating && <Button type="button" variant="secondary" onClick={() => setCreating(true)}>Add a vehicle</Button>}
      {creating && (
        <QuickVehicle customerId={customerId} onCancel={() => setCreating(false)} onCreated={(v) => { setCreating(false); setVehicles((l) => [...l, v]); onChange(v.id, v); }} />
      )}
    </div>
  );
}

function QuickVehicle({ customerId, onCancel, onCreated }: { customerId: string; onCancel: () => void; onCreated: (v: VehicleOption) => void }) {
  const [v, setV] = useState({ registration: '', make: '', model: '', mileageKm: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function save() {
    setBusy(true); setErr(null); setFields({});
    try {
      const r = await api<VehicleOption>('/api/v1/vehicles', { body: { customerId, ...v } });
      onCreated(r.data);
    } catch (e) {
      if (e instanceof ApiError) { setFields(e.fields); setErr(Object.keys(e.fields).length ? 'Please fix the highlighted fields.' : e.message); } else setErr('Could not reach the server.');
    } finally { setBusy(false); }
  }
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <div className="space-y-2 rounded-lg border border-line bg-canvas p-3" role="group" aria-label="New vehicle">
      {err && <Alert>{err}</Alert>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div><Input placeholder="Registration" aria-label="Registration" value={v.registration} onChange={set('registration')} autoCapitalize="characters" aria-invalid={!!fields.registration} />{fields.registration && <p className="mt-1 text-xs text-danger">{fields.registration}</p>}</div>
        <div><Input placeholder="Mileage (km)" aria-label="Mileage" inputMode="numeric" value={v.mileageKm} onChange={set('mileageKm')} aria-invalid={!!fields.mileageKm} />{fields.mileageKm && <p className="mt-1 text-xs text-danger">{fields.mileageKm}</p>}</div>
        <Input placeholder="Make" aria-label="Make" value={v.make} onChange={set('make')} />
        <Input placeholder="Model" aria-label="Model" value={v.model} onChange={set('model')} />
      </div>
      <div className="flex gap-2">
        <Button type="button" loading={busy} onClick={save}>Save vehicle</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
