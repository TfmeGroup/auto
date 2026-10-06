'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { randToCents } from '@/components/workshop/money-input';

/**
 * The forms behind the configuration pages. Each one saves through its own API route; the server validates everything again, applies the plan and
 * permission rules, and writes an audit entry with the old and new values. A disabled form means the person may look but not change.
 */

type Opt = { value: string; label: string };

function Saved({ ok }: { ok: boolean }) {
  return ok ? <p role="status" className="text-sm font-medium text-ok">Saved.</p> : null;
}

function Checks({ legend, options, selected, onChange, disabled, hint }: { legend: string; options: Opt[]; selected: string[]; onChange: (v: string[]) => void; disabled?: boolean; hint?: string }) {
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {hint && <p className="mb-1 text-xs text-muted">{hint}</p>}
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((o) => (
          <label key={o.value} className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm">
            <input type="checkbox" className="size-5" checked={selected.includes(o.value)} onChange={() => onChange(selected.includes(o.value) ? selected.filter((x) => x !== o.value) : [...selected, o.value])} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function useSave(path: string, build: () => unknown, method = 'PATCH') {
  const router = useRouter();
  const s = useSubmit();
  const [saved, setSaved] = useState(false);
  const submit = () => { setSaved(false); void s.run(async () => { await api(path, { method, body: build() }); setSaved(true); router.refresh(); }); };
  return { ...s, saved, submit };
}

// ───────────── numbering ─────────────

interface NumberKind { id: string; label: string; group: string; prefix: string; padding: number; issued: number; nextNumber: string }

export function NumberingForm({ kinds, canEdit }: { kinds: NumberKind[]; canEdit: { workshop: boolean; finance: boolean; inventory: boolean } }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(kinds.map((k) => [k.id, k.prefix])));
  const pad = (g: string) => kinds.find((k) => k.group === g)?.padding ?? 6;
  const [pads, setPads] = useState<Record<string, string>>({ workshop: String(kinds.find((k) => k.id === 'customer')?.padding ?? 6), finance: String(pad('finance')), inventory: String(pad('inventory')) });
  const NAMES: Record<string, string> = { customer: 'customerPrefix', booking: 'bookingPrefix', job: 'jobPrefix', quote: 'quotePrefix', invoice: 'invoicePrefix', payment: 'paymentPrefix', receipt: 'receiptPrefix', credit_note: 'creditNotePrefix', refund: 'refundPrefix', purchase_order: 'poPrefix', goods_receipt: 'goodsReceiptPrefix', stock_transfer: 'transferPrefix', supplier_return: 'supplierReturnPrefix' };
  const GROUPS: [string, string, boolean, string][] = [['workshop', 'Workshop records', canEdit.workshop, 'Needs permission to manage workshop configuration.'], ['finance', 'Quotes, invoices and payments', canEdit.finance, 'Needs permission to manage payment and document settings.'], ['inventory', 'Stock and purchasing', canEdit.inventory, 'Needs permission to manage inventory settings.']];
  const save = useSave('/api/v1/settings/numbering', () => {
    const body: Record<string, unknown> = {};
    for (const k of kinds) if (canEdit[k.group as 'workshop'] && vals[k.id] !== k.prefix) body[NAMES[k.id]!] = vals[k.id];
    if (canEdit.workshop && pads.workshop !== String(kinds.find((k) => k.id === 'customer')!.padding)) { body.customerPadding = pads.workshop; body.bookingPadding = pads.workshop; body.jobPadding = pads.workshop; }
    if (canEdit.finance && pads.finance !== String(pad('finance'))) body.financePadding = pads.finance;
    if (canEdit.inventory && pads.inventory !== String(pad('inventory'))) body.inventoryPadding = pads.inventory;
    return body;
  });
  return (
    <div className="space-y-5">
      {save.error && <Alert>{save.error}</Alert>}
      {GROUPS.map(([g, title, can, why]) => (
        <section key={g} aria-labelledby={`num-${g}`} className="space-y-2">
          <h2 id={`num-${g}`} className="text-base font-semibold">{title}</h2>
          {!can && <p className="text-xs text-muted">{why}</p>}
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {kinds.filter((k) => k.group === g).map((k) => (
              <li key={k.id} className="grid gap-2 px-3 py-3 sm:grid-cols-[1fr_9rem_1fr] sm:items-center">
                <p className="text-sm font-medium">{k.label}<span className="block text-xs font-normal text-muted">{k.issued} issued so far</span></p>
                <Field label="Prefix" htmlFor={`pf-${k.id}`} error={save.fields[NAMES[k.id]!] ?? save.fields[k.id]}><Input id={`pf-${k.id}`} value={vals[k.id]} maxLength={8} disabled={!can} onChange={(e) => setVals({ ...vals, [k.id]: e.target.value.toUpperCase() })} /></Field>
                <p className="text-sm text-muted">Next number: <span className="font-mono text-ink">{vals[k.id]}-{String(k.issued + 1).padStart(Number(pads[g]) || k.padding, '0')}</span></p>
              </li>
            ))}
          </ul>
          <div className="max-w-xs"><Field label="Digits in the number" htmlFor={`pad-${g}`} error={save.fields[`${g === 'workshop' ? 'customer' : g}Padding`]} hint="3 to 10."><Input id={`pad-${g}`} type="number" min={3} max={10} value={pads[g]} disabled={!can} onChange={(e) => setPads({ ...pads, [g]: e.target.value })} /></Field></div>
        </section>
      ))}
      <p className="rounded-lg border border-line bg-canvas p-3 text-sm text-muted">Changing a prefix only affects numbers issued from now on. Each kind keeps counting from where it was, so a number that was issued is never reused or changed. Locations with a document code (Settings, Locations) count on their own.</p>
      {(canEdit.workshop || canEdit.finance || canEdit.inventory) && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save numbering</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── jobs ─────────────

export function JobConfigForm({ statuses, priorities, labels, priorityLabels, retired, required, retirable, requiredOptions, canEdit, locked }: {
  statuses: Opt[]; priorities: Opt[]; labels: Record<string, string>; priorityLabels: Record<string, string>; retired: string[]; required: string[]; retirable: Opt[]; requiredOptions: Opt[]; canEdit: boolean; locked: boolean;
}) {
  const [sl, setSl] = useState(labels);
  const [pl, setPl] = useState(priorityLabels);
  const [ret, setRet] = useState(retired);
  const [req, setReq] = useState(required);
  const save = useSave('/api/v1/settings/jobs', () => ({ statusLabels: sl, priorityLabels: pl, retiredStatuses: ret, requiredFields: req }));
  const off = !canEdit || locked;
  return (
    <div className="space-y-5">
      {locked && <Alert tone="warn">Job configuration is included from the Team plan.</Alert>}
      {save.error && <Alert>{save.error}</Alert>}
      <section aria-labelledby="jc-status" className="space-y-2">
        <h2 id="jc-status" className="text-base font-semibold">Status names</h2>
        <p className="text-xs text-muted">Rename how each stage reads on your screens. The workflow itself (the order jobs move through) is fixed; names are only labels, and history keeps showing the stage it was in.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {statuses.map((s) => <Field key={s.value} label={s.label} htmlFor={`sl-${s.value}`} error={save.fields.statusLabels}><Input id={`sl-${s.value}`} value={sl[s.value] ?? s.label} maxLength={30} disabled={off} onChange={(e) => setSl({ ...sl, [s.value]: e.target.value })} /></Field>)}
        </div>
      </section>
      <section aria-labelledby="jc-pri" className="space-y-2">
        <h2 id="jc-pri" className="text-base font-semibold">Priority names</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {priorities.map((s) => <Field key={s.value} label={s.label} htmlFor={`pl-${s.value}`}><Input id={`pl-${s.value}`} value={pl[s.value] ?? s.label} maxLength={30} disabled={off} onChange={(e) => setPl({ ...pl, [s.value]: e.target.value })} /></Field>)}
        </div>
      </section>
      <Checks legend="Optional steps to switch off" hint="A switched-off step cannot be chosen for a job. Jobs already in that step can still move on, so nothing is stranded." options={retirable} selected={ret} onChange={setRet} disabled={off} />
      <Checks legend="Required when a job is opened" hint="The mileage is asked for when the vehicle arrives." options={requiredOptions} selected={req} onChange={setReq} disabled={off} />
      {!off && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save job settings</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── vehicles ─────────────

export function VehicleConfigForm({ initial, fieldOptions, fuel, transmission, drive, canEdit, locked }: {
  initial: { requiredFields: string[]; mileageRequired: boolean; enabledFuelTypes: string[]; enabledTransmissions: string[]; enabledDriveTypes: string[]; defaultIntervalKm: number | null; defaultIntervalMonths: number | null };
  fieldOptions: Opt[]; fuel: Opt[]; transmission: Opt[]; drive: Opt[]; canEdit: boolean; locked: boolean;
}) {
  const [s, setS] = useState({ ...initial, defaultIntervalKm: String(initial.defaultIntervalKm ?? ''), defaultIntervalMonths: String(initial.defaultIntervalMonths ?? '') });
  const save = useSave('/api/v1/settings/vehicles', () => ({ requiredFields: s.requiredFields, mileageRequired: s.mileageRequired, enabledFuelTypes: s.enabledFuelTypes, enabledTransmissions: s.enabledTransmissions, enabledDriveTypes: s.enabledDriveTypes, defaultIntervalKm: s.defaultIntervalKm, defaultIntervalMonths: s.defaultIntervalMonths }));
  const off = !canEdit || locked;
  return (
    <div className="space-y-5">
      {locked && <Alert tone="warn">Vehicle rules are included from the Team plan.</Alert>}
      {save.error && <Alert>{save.error}</Alert>}
      <Checks legend="Required when a vehicle is added" options={fieldOptions} selected={s.requiredFields} onChange={(v) => setS({ ...s, requiredFields: v })} disabled={off} />
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={s.mileageRequired} disabled={off} onChange={(e) => setS({ ...s, mileageRequired: e.target.checked })} />The odometer reading is required when a vehicle is added</label>
      <Checks legend="Fuel types in use" hint="Tick none to allow all. A type you untick stays on vehicles that already have it." options={fuel} selected={s.enabledFuelTypes} onChange={(v) => setS({ ...s, enabledFuelTypes: v })} disabled={off} />
      <Checks legend="Transmissions in use" options={transmission} selected={s.enabledTransmissions} onChange={(v) => setS({ ...s, enabledTransmissions: v })} disabled={off} />
      <Checks legend="Drive types in use" options={drive} selected={s.enabledDriveTypes} onChange={(v) => setS({ ...s, enabledDriveTypes: v })} disabled={off} />
      <div className="grid max-w-lg gap-3 sm:grid-cols-2">
        <Field label="Default service interval (km)" htmlFor="vc-km" error={save.fields.defaultIntervalKm} hint="Used when a service interval is added without one."><Input id="vc-km" type="number" min={100} value={s.defaultIntervalKm} disabled={off} onChange={(e) => setS({ ...s, defaultIntervalKm: e.target.value })} /></Field>
        <Field label="Default service interval (months)" htmlFor="vc-mo" error={save.fields.defaultIntervalMonths}><Input id="vc-mo" type="number" min={1} value={s.defaultIntervalMonths} disabled={off} onChange={(e) => setS({ ...s, defaultIntervalMonths: e.target.value })} /></Field>
      </div>
      {!off && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save vehicle settings</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── reporting preferences ─────────────

export function ReportingForm({ initial, ranges, kpis, canEdit }: {
  initial: { reportDefaultRange: string; reportDefaultFormat: string; slowMovingDays: number; lapsedCustomerDays: number; dashboardHiddenKpis: string[] }; ranges: Opt[]; kpis: Opt[]; canEdit: boolean;
}) {
  const [s, setS] = useState({ ...initial, slowMovingDays: String(initial.slowMovingDays), lapsedCustomerDays: String(initial.lapsedCustomerDays) });
  const save = useSave('/api/v1/settings/reporting', () => s);
  return (
    <div className="space-y-5">
      {save.error && <Alert>{save.error}</Alert>}
      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <Field label="Default report period" htmlFor="rp-range" hint="Used when a report is opened without choosing a period."><Select id="rp-range" value={s.reportDefaultRange} disabled={!canEdit} onChange={(e) => setS({ ...s, reportDefaultRange: e.target.value })}>{ranges.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select></Field>
        <Field label="Preferred export format" htmlFor="rp-fmt"><Select id="rp-fmt" value={s.reportDefaultFormat} disabled={!canEdit} onChange={(e) => setS({ ...s, reportDefaultFormat: e.target.value })}><option value="CSV">CSV</option><option value="XLSX">Excel</option><option value="PDF">PDF</option></Select></Field>
        <Field label="Slow-moving stock after (days)" htmlFor="rp-slow" error={save.fields.slowMovingDays} hint="A part in stock with no use or sale for this long is flagged."><Input id="rp-slow" type="number" min={14} max={730} value={s.slowMovingDays} disabled={!canEdit} onChange={(e) => setS({ ...s, slowMovingDays: e.target.value })} /></Field>
        <Field label="Customer “not seen” after (days)" htmlFor="rp-lapsed" error={save.fields.lapsedCustomerDays} hint="Used by the customer retention report."><Input id="rp-lapsed" type="number" min={30} max={1095} value={s.lapsedCustomerDays} disabled={!canEdit} onChange={(e) => setS({ ...s, lapsedCustomerDays: e.target.value })} /></Field>
      </div>
      <Checks legend="Hide these blocks on the dashboard" hint="A preference only: it can hide something, never reveal anything your role does not allow." options={kpis} selected={s.dashboardHiddenKpis} onChange={(v) => setS({ ...s, dashboardHiddenKpis: v })} disabled={!canEdit} />
      <p className="text-sm text-muted">Dates in reports follow the business time zone, set under Business.</p>
      {canEdit && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save reporting settings</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── labour rounding ─────────────

export function LabourRulesForm({ initial, canEdit, locked }: { initial: { minBillableMinutes: number; timeRoundingMinutes: number; timeRoundingMode: string }; canEdit: boolean; locked: boolean }) {
  const [s, setS] = useState({ minBillableMinutes: String(initial.minBillableMinutes), timeRoundingMinutes: String(initial.timeRoundingMinutes), timeRoundingMode: initial.timeRoundingMode });
  const save = useSave('/api/v1/settings/labour', () => s);
  const off = !canEdit || locked;
  return (
    <div className="space-y-3">
      {locked && <Alert tone="warn">Time rounding and minimum billable time are included from the Team plan.</Alert>}
      {save.error && <Alert>{save.error}</Alert>}
      <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
        <Field label="Round recorded time to" htmlFor="lr-step"><Select id="lr-step" value={s.timeRoundingMinutes} disabled={off} onChange={(e) => setS({ ...s, timeRoundingMinutes: e.target.value })}>{[0, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m === 0 ? 'No rounding' : `${m} minutes`}</option>)}</Select></Field>
        <Field label="Rounding" htmlFor="lr-mode"><Select id="lr-mode" value={s.timeRoundingMode} disabled={off || s.timeRoundingMinutes === '0'} onChange={(e) => setS({ ...s, timeRoundingMode: e.target.value })}><option value="UP">Always up</option><option value="NEAREST">To the nearest</option></Select></Field>
        <Field label="Minimum billable minutes" htmlFor="lr-min" error={save.fields.minBillableMinutes} hint="0 for none."><Input id="lr-min" type="number" min={0} max={480} value={s.minBillableMinutes} disabled={off} onChange={(e) => setS({ ...s, minBillableMinutes: e.target.value })} /></Field>
      </div>
      <p className="text-sm text-muted">Applies when recorded time becomes a labour line. The time entry keeps the minutes actually worked and the line shows both, so you can always see worked versus billed. Labour already recorded is never changed.</p>
      {!off && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save labour rules</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── inventory defaults ─────────────

export function InventoryDefaultsForm({ initial, canEdit }: { initial: { defaultReorderQuantity: number | null; defaultMarkupPercent: number | null }; canEdit: boolean }) {
  const [s, setS] = useState({ defaultReorderQuantity: String(initial.defaultReorderQuantity ?? ''), defaultMarkupPercent: String(initial.defaultMarkupPercent ?? '') });
  const save = useSave('/api/v1/settings/inventory-defaults', () => s);
  return (
    <div className="space-y-3">
      {save.error && <Alert>{save.error}</Alert>}
      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <Field label="Default reorder quantity" htmlFor="id-rq" error={save.fields.defaultReorderQuantity} hint="Filled in on a new part when you leave it blank."><Input id="id-rq" type="number" min={1} value={s.defaultReorderQuantity} disabled={!canEdit} onChange={(e) => setS({ ...s, defaultReorderQuantity: e.target.value })} /></Field>
        <Field label="Default markup on cost (%)" htmlFor="id-mk" error={save.fields.defaultMarkupPercent} hint="A new part with a cost and no selling price gets cost plus this."><Input id="id-mk" type="number" min={0} step="0.1" value={s.defaultMarkupPercent} disabled={!canEdit} onChange={(e) => setS({ ...s, defaultMarkupPercent: e.target.value })} /></Field>
      </div>
      <p className="text-sm text-muted">Only new parts are affected. Existing parts and their prices are never changed by these defaults.</p>
      {canEdit && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save defaults</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── security ─────────────

export function SecurityLimitsForm({ initial, canEdit }: { initial: { sessionMaxHours: number | null; invitationExpiryDays: number | null }; canEdit: boolean }) {
  const [s, setS] = useState({ sessionMaxHours: String(initial.sessionMaxHours ?? ''), invitationExpiryDays: String(initial.invitationExpiryDays ?? '') });
  const save = useSave('/api/v1/settings/security', () => s);
  return (
    <div className="space-y-3">
      {save.error && <Alert>{save.error}</Alert>}
      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <Field label="Sign in again after (hours)" htmlFor="sl-hours" error={save.fields.sessionMaxHours} hint="Empty = the standard session length. Everyone working in this business is signed out after this long."><Input id="sl-hours" type="number" min={1} max={720} value={s.sessionMaxHours} disabled={!canEdit} onChange={(e) => setS({ ...s, sessionMaxHours: e.target.value })} /></Field>
        <Field label="Invitations expire after (days)" htmlFor="sl-days" error={save.fields.invitationExpiryDays} hint="Empty = 7 days. Applies to invitations sent from now on."><Input id="sl-days" type="number" min={1} max={30} value={s.invitationExpiryDays} disabled={!canEdit} onChange={(e) => setS({ ...s, invitationExpiryDays: e.target.value })} /></Field>
      </div>
      {canEdit && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── retention ─────────────

export function RetentionForm({ initial, canEdit }: { initial: { trashRetentionDays: number; financialRetentionYears: number; reportRunRetentionDays: number; importRetentionDays: number }; canEdit: boolean }) {
  const [s, setS] = useState(Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, String(v)])));
  const save = useSave('/api/v1/settings/retention', () => s);
  const f = (id: string, label: string, hint: string, min: number, max: number) => <Field label={label} htmlFor={`rt-${id}`} error={save.fields[id]} hint={hint}><Input id={`rt-${id}`} type="number" min={min} max={max} value={s[id]} disabled={!canEdit} onChange={(e) => setS({ ...s, [id]: e.target.value })} /></Field>;
  return (
    <div className="space-y-3">
      {save.error && <Alert>{save.error}</Alert>}
      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        {f('trashRetentionDays', 'Keep removed documents (days)', 'Documents in the trash are deleted for good after this long.', 1, 3650)}
        {f('financialRetentionYears', 'Keep financial documents (years)', `Can be lengthened, never shortened below ${initial.financialRetentionYears}.`, initial.financialRetentionYears, 50)}
        {f('reportRunRetentionDays', 'Keep scheduled-report history (days)', 'Run records and the report files that were emailed.', 7, 3650)}
        {f('importRetentionDays', 'Keep import files (days)', 'The staged rows of finished imports. The records they created stay.', 1, 365)}
      </div>
      <p className="text-sm text-muted">The audit log and the communication history are kept permanently and cannot be shortened here.</p>
      {canEdit && <div className="flex items-center gap-3"><Button type="button" onClick={save.submit} loading={save.pending || !save.ready}>Save retention</Button><Saved ok={save.saved} /></div>}
    </div>
  );
}

// ───────────── services ─────────────

interface PartOpt { value: string; label: string }
interface Service { id: string; name: string; description: string | null; defaultDurationMin: number; labourRateCentsPerHour: number | null; defaultPriceCents: number | null; taxTreatment: string; checklist: string[]; parts: { partId: string; quantity: number }[]; status: string }

export function ServiceForm({ service, parts, canRates, disabled }: { service?: Service; parts: PartOpt[]; canRates: boolean; disabled?: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [lines, setLines] = useState(service?.parts ?? []);
  const [saved, setSaved] = useState(false);
  const rand = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
  return (
    <form
      method="post" noValidate className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const checklist = String(f.get('checklist') ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
        const body: Record<string, unknown> = {
          name: f.get('name'), description: f.get('description') || null, defaultDurationMin: f.get('defaultDurationMin'), defaultPriceCents: randToCents(String(f.get('price') ?? '')), taxTreatment: f.get('taxTreatment'), checklist, defaultParts: lines.filter((l) => l.partId),
        };
        if (canRates) body.labourRateCentsPerHour = randToCents(String(f.get('rate') ?? ''));
        setSaved(false);
        void run(async () => { await api(service ? `/api/v1/settings/services/${service.id}` : '/api/v1/settings/services', { method: service ? 'PATCH' : 'POST', body }); setSaved(true); if (!service) e.currentTarget.reset(); router.refresh(); });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <fieldset disabled={disabled} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" htmlFor={`sv-name-${service?.id ?? 'new'}`} error={fields.name}><Input id={`sv-name-${service?.id ?? 'new'}`} name="name" required defaultValue={service?.name} maxLength={80} /></Field>
          <Field label="Default length (minutes)" htmlFor={`sv-dur-${service?.id ?? 'new'}`} error={fields.defaultDurationMin}><Input id={`sv-dur-${service?.id ?? 'new'}`} name="defaultDurationMin" type="number" min={5} max={1440} defaultValue={service?.defaultDurationMin ?? 60} /></Field>
          <Field label="Default price (R, optional)" htmlFor={`sv-price-${service?.id ?? 'new'}`} error={fields.defaultPriceCents} hint="Becomes a ready-made line on quotes and invoices."><Input id={`sv-price-${service?.id ?? 'new'}`} name="price" inputMode="decimal" defaultValue={rand(service?.defaultPriceCents)} /></Field>
          <Field label="VAT treatment" htmlFor={`sv-tax-${service?.id ?? 'new'}`}><Select id={`sv-tax-${service?.id ?? 'new'}`} name="taxTreatment" defaultValue={service?.taxTreatment ?? 'STANDARD'}><option value="STANDARD">Standard rate</option><option value="ZERO_RATED">Zero-rated</option><option value="EXEMPT">Exempt</option></Select></Field>
          {canRates && <Field label="Labour rate for this service (R per hour)" htmlFor={`sv-rate-${service?.id ?? 'new'}`} error={fields.labourRateCentsPerHour} hint="Overrides the business rate for jobs of this service."><Input id={`sv-rate-${service?.id ?? 'new'}`} name="rate" inputMode="decimal" defaultValue={rand(service?.labourRateCentsPerHour)} /></Field>}
        </div>
        <Field label="Description" htmlFor={`sv-desc-${service?.id ?? 'new'}`}><Textarea id={`sv-desc-${service?.id ?? 'new'}`} name="description" rows={2} maxLength={500} defaultValue={service?.description ?? ''} /></Field>
        <Field label="Checklist (one item per line)" htmlFor={`sv-chk-${service?.id ?? 'new'}`} error={fields.checklist}><Textarea id={`sv-chk-${service?.id ?? 'new'}`} name="checklist" rows={3} defaultValue={service?.checklist.join('\n')} /></Field>
        <PartLines lines={lines} setLines={setLines} parts={parts} error={fields.defaultParts} />
        <div className="flex items-center gap-3"><Button type="submit" loading={pending || !ready}>{service ? 'Save service' : 'Add service'}</Button><Saved ok={saved} /></div>
      </fieldset>
    </form>
  );
}

function PartLines({ lines, setLines, parts, error }: { lines: { partId: string; quantity: number }[]; setLines: (l: { partId: string; quantity: number }[]) => void; parts: PartOpt[]; error?: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Parts normally used</legend>
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_auto] gap-2">
          <Select aria-label={`Part ${i + 1}`} value={l.partId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, partId: e.target.value } : x)))}><option value="">Choose a part…</option>{parts.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          <Input aria-label={`Quantity ${i + 1}`} type="number" min={1} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
          <Button type="button" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      {lines.length < 30 && <Button type="button" variant="secondary" onClick={() => setLines([...lines, { partId: '', quantity: 1 }])}>Add a part</Button>}
    </fieldset>
  );
}

// ───────────── job templates ─────────────

interface Template { id: string; name: string; description: string | null; serviceTypeId: string | null; estimatedMinutes: number | null; checklist: string[]; inspectionFields: string[]; labour: { description: string; minutes: number }[]; parts: { partId: string; quantity: number }[] }

export function TemplateForm({ template, services, parts, disabled }: { template?: Template; services: Opt[]; parts: PartOpt[]; disabled?: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [labour, setLabour] = useState(template?.labour ?? []);
  const [lines, setLines] = useState(template?.parts ?? []);
  const [saved, setSaved] = useState(false);
  const id = template?.id ?? 'new';
  const split = (v: FormDataEntryValue | null) => String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <form
      method="post" noValidate className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body = { name: f.get('name'), description: f.get('description') || null, serviceTypeId: f.get('serviceTypeId') || null, estimatedMinutes: f.get('estimatedMinutes') || null, checklist: split(f.get('checklist')), inspectionFields: split(f.get('inspection')), labour: labour.filter((l) => l.description.trim()), parts: lines.filter((l) => l.partId) };
        setSaved(false);
        void run(async () => { await api(template ? `/api/v1/settings/job-templates/${template.id}` : '/api/v1/settings/job-templates', { method: template ? 'PATCH' : 'POST', body }); setSaved(true); if (!template) e.currentTarget.reset(); if (!template) { setLabour([]); setLines([]); } router.refresh(); });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <fieldset disabled={disabled} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Template name" htmlFor={`jt-name-${id}`} error={fields.name}><Input id={`jt-name-${id}`} name="name" required defaultValue={template?.name} maxLength={80} /></Field>
          <Field label="Service" htmlFor={`jt-svc-${id}`}><Select id={`jt-svc-${id}`} name="serviceTypeId" defaultValue={template?.serviceTypeId ?? ''}><option value="">None</option>{services.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
          <Field label="Estimated time (minutes)" htmlFor={`jt-est-${id}`} error={fields.estimatedMinutes}><Input id={`jt-est-${id}`} name="estimatedMinutes" type="number" min={5} defaultValue={template?.estimatedMinutes ?? ''} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Checklist (one item per line)" htmlFor={`jt-chk-${id}`}><Textarea id={`jt-chk-${id}`} name="checklist" rows={3} defaultValue={template?.checklist.join('\n')} /></Field>
          <Field label="Inspection points (one per line)" htmlFor={`jt-ins-${id}`}><Textarea id={`jt-ins-${id}`} name="inspection" rows={3} defaultValue={template?.inspectionFields.join('\n')} /></Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Labour</legend>
          {labour.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem_auto] gap-2">
              <Input aria-label={`Labour ${i + 1}`} value={l.description} maxLength={200} placeholder="What the labour is for" onChange={(e) => setLabour(labour.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <Input aria-label={`Minutes ${i + 1}`} type="number" min={1} value={l.minutes} onChange={(e) => setLabour(labour.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)))} />
              <Button type="button" variant="ghost" onClick={() => setLabour(labour.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          {labour.length < 30 && <Button type="button" variant="secondary" onClick={() => setLabour([...labour, { description: '', minutes: 60 }])}>Add labour</Button>}
        </fieldset>
        <PartLines lines={lines} setLines={setLines} parts={parts} error={fields.parts} />
        <div className="flex items-center gap-3"><Button type="submit" loading={pending || !ready}>{template ? 'Save template' : 'Add template'}</Button><Saved ok={saved} /></div>
      </fieldset>
    </form>
  );
}
