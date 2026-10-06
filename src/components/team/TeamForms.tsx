'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { centsToRand, randToCentsOrNull } from '@/components/inventory/shared';

/** Designate someone as a technician, mark them inactive, and set skills, services and rates. Rates need their own permission; the server checks it again. */
export function TechnicianForm({
  membershipId, isTechnician, status, skills, serviceTypeIds, services, notes, billable, cost, canRates, canSeeCost,
}: {
  membershipId: string; isTechnician: boolean; status: string; skills: string[]; serviceTypeIds: string[]; services: { id: string; name: string }[]; notes: string | null;
  billable: number | null; cost: number | null; canRates: boolean; canSeeCost: boolean;
}) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const [msg, setMsg] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(serviceTypeIds));
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const el = (n: string) => f.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const body: Record<string, unknown> = {
          isTechnician: (el('isTechnician') as HTMLInputElement).checked, status: el('status').value,
          skills: el('skills').value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean), serviceTypeIds: [...chosen], notes: el('notes').value.trim(),
        };
        if (canRates) {
          const b = randToCentsOrNull(el('billable').value);
          const c = canSeeCost ? randToCentsOrNull(el('cost').value) : undefined;
          if (b === undefined || c === undefined && canSeeCost) { setBad('Enter rates as amounts per hour, like 650 or 650.00.'); return; }
          body.billableRateCentsPerHour = b;
          if (canSeeCost) body.labourCostCentsPerHour = c;
        }
        setBad(null);
        setMsg(null);
        void run(async () => {
          const r = await api<{ affected: { openJobs: number; upcomingBookings: number } }>(`/api/v1/team/technicians/${membershipId}`, { method: 'PATCH', body });
          const a = r.data.affected;
          setMsg(a.openJobs + a.upcomingBookings > 0 ? `Saved. Nothing was moved: ${a.openJobs} open job${a.openJobs === 1 ? '' : 's'} and ${a.upcomingBookings} upcoming booking${a.upcomingBookings === 1 ? '' : 's'} are still assigned to them. The people who run the schedule were told.` : 'Saved.');
          router.refresh();
        });
      }}
    >
      {(bad || error) && <Alert>{bad ?? error}</Alert>}
      {msg && !error && <Alert tone="ok">{msg}</Alert>}
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name="isTechnician" defaultChecked={isTechnician} className="size-5" /><span><span className="font-medium">This person is a technician</span><span className="block text-xs text-muted">Technicians can be assigned to jobs and bookings.</span></span></label>
      <Field label="Status" htmlFor="tf-status" hint="An inactive technician cannot be given new work. Jobs they already hold stay as they are.">
        <Select id="tf-status" name="status" defaultValue={status}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select>
      </Field>
      <Field label="Skills" htmlFor="tf-skills" hint="Separate with commas: diagnostics, brakes, electrical"><Input id="tf-skills" name="skills" defaultValue={skills.join(', ')} /></Field>
      {services.length > 0 && (
        <fieldset className="space-y-1"><legend className="text-sm font-medium">Services they can do</legend>
          <div className="grid gap-1 sm:grid-cols-2">{services.map((s) => <label key={s.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={chosen.has(s.id)} onChange={() => setChosen((c) => { const n = new Set(c); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />{s.name}</label>)}</div>
        </fieldset>
      )}
      {canRates && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Billable rate (rand per hour)" htmlFor="tf-bill" hint="Charged to customers. Overrides the service and business rates."><Input id="tf-bill" name="billable" inputMode="decimal" defaultValue={centsToRand(billable)} /></Field>
          {canSeeCost && <Field label="Cost rate (rand per hour)" htmlFor="tf-cost" hint="What an hour of their time costs the business. Never shown to customers."><Input id="tf-cost" name="cost" inputMode="decimal" defaultValue={centsToRand(cost)} /></Field>}
        </div>
      )}
      <Field label="Notes" htmlFor="tf-notes"><Textarea id="tf-notes" name="notes" rows={2} defaultValue={notes ?? ''} /></Field>
      <Button type="submit" loading={pending || !ready}>Save technician settings</Button>
    </form>
  );
}

export function MemberLocationsForm({ membershipId, all, chosen, locations }: { membershipId: string; all: boolean; chosen: string[]; locations: { id: string; name: string }[] }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const [allLoc, setAllLoc] = useState(all);
  const [set, setSet] = useState<Set<string>>(new Set(chosen));
  const [saved, setSaved] = useState(false);
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void run(async () => { await api(`/api/v1/team/employees/${membershipId}/locations`, { method: 'PATCH', body: { allLocations: allLoc, locationIds: allLoc ? [] : [...set] } }); setSaved(true); router.refresh(); });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {saved && !error && <Alert tone="ok">Locations saved.</Alert>}
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={allLoc} onChange={(e) => setAllLoc(e.target.checked)} />Can work at every location</label>
      {!allLoc && <div className="grid gap-1 sm:grid-cols-2">{locations.map((l) => <label key={l.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={set.has(l.id)} onChange={() => setSet((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} />{l.name}</label>)}</div>}
      <Button type="submit" variant="secondary" loading={pending || !ready}>Save locations</Button>
    </form>
  );
}

export function RateCardForm({ defaultRate, services, technicians, canManage, canSeeCosts }: { defaultRate: number | null; services: { id: string; name: string; labourRateCentsPerHour: number | null }[]; technicians: { membershipId: string; name: string; billableRateCentsPerHour: number | null; costRateCentsPerHour: number | null }[]; canManage: boolean; canSeeCosts: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save(key: string, path: string, method: 'PUT' | 'PATCH', value: string, field = 'rateCentsPerHour') {
    const cents = randToCentsOrNull(value);
    if (cents === undefined) { setMsg({ tone: 'danger', text: 'Enter the rate as an amount per hour, like 650 or 650.00.' }); return; }
    setBusy(key);
    setMsg(null);
    try { await api(path, { method, body: { [field]: cents } }); setMsg({ tone: 'ok', text: 'Saved. New rates apply to labour recorded from now on; existing labour and invoices are not changed.' }); router.refresh(); } catch (e) { setMsg({ tone: 'danger', text: e instanceof Error ? e.message : 'Could not save.' }); } finally { setBusy(null); }
  }
  const row = (key: string, label: string, value: number | null, onSave: (v: string) => void) => (
    <form key={key} className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); onSave((new FormData(e.currentTarget).get('rate') as string) ?? ''); }}>
      <div className="min-w-0 flex-1"><Field label={label} htmlFor={`rate-${key}`}><Input id={`rate-${key}`} name="rate" inputMode="decimal" defaultValue={centsToRand(value)} disabled={!canManage} placeholder="not set" /></Field></div>
      {canManage && <Button type="submit" variant="secondary" loading={busy === key}>Save</Button>}
    </form>
  );
  return (
    <div className="space-y-5">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <section className="space-y-2"><h2 className="text-base font-semibold">Default rate</h2><p className="text-xs text-muted">Used when neither the technician nor the service has a rate of its own.</p>{row('default', 'Rand per hour', defaultRate, (v) => void save('default', '/api/v1/team/rates/default', 'PUT', v))}</section>
      <section className="space-y-2"><h2 className="text-base font-semibold">By service</h2>{services.length === 0 ? <p className="text-sm text-muted">No services set up.</p> : services.map((s) => row(`s-${s.id}`, s.name, s.labourRateCentsPerHour, (v) => void save(`s-${s.id}`, `/api/v1/team/rates/service/${s.id}`, 'PUT', v)))}</section>
      <section className="space-y-2"><h2 className="text-base font-semibold">By technician</h2><p className="text-xs text-muted">A technician&apos;s own rate wins over the service and default rates. Change it on their profile.</p>
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">{technicians.map((t) => <li key={t.membershipId} className="flex flex-wrap justify-between gap-2 px-3 py-2"><a href={`/team/${t.membershipId}?tab=technician`} className="font-medium text-brand-700 hover:underline">{t.name}</a><span className="tabular-nums text-muted">{t.billableRateCentsPerHour !== null ? `R ${(t.billableRateCentsPerHour / 100).toFixed(2)}/h` : 'uses service / default'}{canSeeCosts && t.costRateCentsPerHour !== null ? ` · costs R ${(t.costRateCentsPerHour / 100).toFixed(2)}/h` : ''}</span></li>)}</ul>
      </section>
    </div>
  );
}
