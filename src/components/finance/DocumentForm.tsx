'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PartPicker } from '@/components/inventory/PartPicker';
import clsx from 'clsx';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { CustomerPicker, VehiclePicker, type CustomerOption } from '@/components/workshop/Pickers';
import { api } from '@/lib/api-client';
import { formatMoney, parseDecimalToCents, parseQuantityToMilli } from '@/lib/money';
// The calculation is pure, so the browser can PREVIEW totals with the very function the server uses. The server still
// recalculates everything when you save and ignores any total sent from here.
import { calculateDocument, type LineCalcInput } from '@/server/finance/calc';
import { lineKey } from './line-state';

export interface LineState {
  key: string;
  id?: string;
  recommendedWorkId?: string | null;
  lineType: 'PART' | 'LABOUR' | 'SERVICE' | 'CHARGE' | 'OTHER';
  description: string;
  sku: string;
  unit: string;
  qty: string;
  price: string;
  discountType: 'NONE' | 'PERCENT' | 'FIXED';
  discount: string;
  taxTreatment: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  cost: string;
  /** Set when the line was picked from the stock catalogue (the server takes the cost from there). */
  inventoryItemId?: string | null;
}

export interface DocFormInitial {
  customer?: CustomerOption | null;
  vehicleId?: string;
  jobId?: string;
  jobLabel?: string;
  title?: string;
  description?: string;
  validUntil?: string;
  invoiceDate?: string;
  dueDate?: string;
  paymentTermsDays?: string;
  terms?: string;
  customerNotes?: string;
  internalNotes?: string;
  discountType?: 'NONE' | 'PERCENT' | 'FIXED';
  discount?: string;
  lines: LineState[];
}

export const newLine = (over: Partial<LineState> = {}): LineState => ({
  key: lineKey(), lineType: 'PART', description: '', sku: '', unit: '', qty: '1', price: '', discountType: 'NONE', discount: '', taxTreatment: 'STANDARD', cost: '', ...over,
});

const num = (s: string) => s.replace(/[Rr\s]/g, '').replace(',', '.');

function toCalc(l: LineState): LineCalcInput | null {
  try {
    const dt = l.discountType;
    return {
      quantityMilli: parseQuantityToMilli(num(l.qty) || '0'),
      unitPriceCents: parseDecimalToCents(num(l.price) || '0'),
      discountType: dt,
      discountValue: dt === 'NONE' ? 0 : parseDecimalToCents(num(l.discount) || '0'), // percent "10.5" -> 1050 basis points; rand "25" -> 2500 cents
      taxTreatment: l.taxTreatment,
    };
  } catch {
    return null;
  }
}

function toPayload(l: LineState, canCost: boolean) {
  const c = toCalc(l);
  return {
    id: l.id, recommendedWorkId: l.recommendedWorkId ?? undefined, inventoryItemId: l.inventoryItemId ?? undefined, lineType: l.lineType, description: l.description, sku: l.sku, unit: l.unit,
    quantityMilli: c?.quantityMilli ?? 0, unitPriceCents: c?.unitPriceCents ?? -1, discountType: l.discountType, discountValue: c?.discountValue ?? 0, taxTreatment: l.taxTreatment,
    ...(canCost && l.cost.trim() !== '' ? { unitCostCents: (() => { try { return parseDecimalToCents(num(l.cost)); } catch { return -1; } })() } : {}),
  };
}

export function DocumentForm({
  kind, mode, endpoint, method, basePath, initial, tax, currency, locale, canSeeCosts, canCreateCustomer, canCreateVehicle, requireChangeNote, offerFromJob, submitLabel, canPickParts, services,
}: {
  /** Services from the catalogue that have a default price: picking one adds a line with that price and VAT treatment (a copy, not a link). */
  services?: { id: string; name: string; priceCents: number; taxTreatment: string }[];
  /** Offer "Add from stock": lines picked there carry the catalogue part, its SKU and its selling price. */
  canPickParts?: boolean;
  kind: 'quote' | 'invoice';
  mode: 'create' | 'edit';
  endpoint: string;
  method: 'POST' | 'PATCH';
  basePath: string;
  initial: DocFormInitial;
  tax: { vatRegistered: boolean; vatRateBps: number; pricesIncludeVat: boolean };
  currency: string;
  locale: string;
  canSeeCosts: boolean;
  canCreateCustomer: boolean;
  canCreateVehicle: boolean;
  /** Editing a quote the customer already has: the change creates a new version and needs a reason. */
  requireChangeNote?: boolean;
  offerFromJob?: boolean;
  submitLabel: string;
}) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [customer, setCustomer] = useState<CustomerOption | null>(initial.customer ?? null);
  const [vehicleId, setVehicleId] = useState(initial.vehicleId ?? '');
  const [lines, setLines] = useState<LineState[]>(initial.lines);
  const [v, setV] = useState({
    title: initial.title ?? '', description: initial.description ?? '', validUntil: initial.validUntil ?? '', invoiceDate: initial.invoiceDate ?? '', dueDate: initial.dueDate ?? '',
    paymentTermsDays: initial.paymentTermsDays ?? '', terms: initial.terms ?? '', customerNotes: initial.customerNotes ?? '', internalNotes: initial.internalNotes ?? '', changeNote: '',
    discountType: (initial.discountType ?? 'NONE') as 'NONE' | 'PERCENT' | 'FIXED', discount: initial.discount ?? '',
  });
  const [fromJob, setFromJob] = useState(!!offerFromJob && initial.lines.length === 0);
  const [picking, setPicking] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const money = (c: number) => formatMoney(c, currency, locale);

  const patchLine = (key: string, p: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const preview = useMemo(() => {
    const parsed = lines.map(toCalc);
    if (parsed.some((p) => !p) || lines.length === 0) return null;
    let dv = 0;
    try { dv = v.discountType === 'NONE' ? 0 : parseDecimalToCents(num(v.discount) || '0'); } catch { return null; }
    try {
      const calc = calculateDocument(parsed as LineCalcInput[], tax, { type: v.discountType, value: dv });
      return calc;
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Check the lines' } as const;
    }
  }, [lines, v.discountType, v.discount, tax]);

  const hasPreview = preview && !('error' in preview);

  return (
    <form
      method="post"
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const body: Record<string, unknown> = {
            vehicleId, title: v.title, terms: v.terms, customerNotes: v.customerNotes, internalNotes: v.internalNotes, discountType: v.discountType,
            discountValue: v.discountType === 'NONE' ? 0 : (() => { try { return parseDecimalToCents(num(v.discount) || '0'); } catch { return -1; } })(),
            lines: fromJob ? undefined : lines.map((l) => toPayload(l, canSeeCosts)),
          };
          if (mode === 'create') { body.customerId = customer?.id ?? ''; body.jobId = initial.jobId ?? ''; if (fromJob) body.fromJob = true; }
          if (kind === 'quote') { body.description = v.description; if (v.validUntil) body.validUntil = v.validUntil; if (requireChangeNote) body.changeNote = v.changeNote; }
          if (kind === 'invoice') { if (v.invoiceDate) body.invoiceDate = v.invoiceDate; if (v.dueDate) body.dueDate = v.dueDate; if (v.paymentTermsDays) body.paymentTermsDays = Number(v.paymentTermsDays); }
          if (mode === 'edit') { delete body.vehicleId; if (vehicleId !== (initial.vehicleId ?? '') && vehicleId) body.vehicleId = vehicleId; }
          const res = await api<{ id: string; warnings?: string[] }>(endpoint, { method, body });
          const notice = res.data.warnings?.length ? `?notice=${encodeURIComponent(res.data.warnings.join(' '))}` : '';
          router.push(`${basePath}/${res.data.id ?? ''}${notice}`);
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">{mode === 'create' ? 'Customer and vehicle' : 'Customer'}</h2>
        {mode === 'create' ? (
          <>
            <Field label="Customer" htmlFor="doc-customer" error={fields.customerId}>
              <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setVehicleId(''); }} canCreate={canCreateCustomer} error={fields.customerId} />
            </Field>
            <Field label="Vehicle (optional)" htmlFor="doc-vehicle" error={fields.vehicleId}>
              <VehiclePicker customerId={customer?.id ?? null} value={vehicleId} onChange={(id) => setVehicleId(id)} canCreate={canCreateVehicle} error={fields.vehicleId} />
            </Field>
          </>
        ) : (
          <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm">{customer?.name}</p>
        )}
        {initial.jobId && <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm">For job <strong>{initial.jobLabel ?? 'selected job'}</strong></p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Details</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label={kind === 'quote' ? 'Subject (shown to the customer)' : 'Title (optional)'} htmlFor="doc-title" error={fields.title}>
              <Input id="doc-title" value={v.title} onChange={set('title')} maxLength={150} placeholder={kind === 'quote' ? 'e.g. Timing belt replacement' : 'e.g. Major service'} />
            </Field>
          </div>
          {kind === 'quote' && (
            <>
              <Field label="Valid until" htmlFor="doc-valid" error={fields.validUntil} hint="Leave empty to use your default validity.">
                <Input id="doc-valid" type="date" value={v.validUntil} onChange={set('validUntil')} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Description (shown to the customer)" htmlFor="doc-desc" error={fields.description}>
                  <Textarea id="doc-desc" rows={2} value={v.description} onChange={set('description')} maxLength={2000} />
                </Field>
              </div>
            </>
          )}
          {kind === 'invoice' && (
            <>
              <Field label="Invoice date" htmlFor="doc-idate" error={fields.invoiceDate} hint="Leave empty for the day it is issued.">
                <Input id="doc-idate" type="date" value={v.invoiceDate} onChange={set('invoiceDate')} />
              </Field>
              <Field label="Payment terms (days)" htmlFor="doc-terms-days" error={fields.paymentTermsDays} hint="Leave empty to use your default.">
                <Input id="doc-terms-days" inputMode="numeric" value={v.paymentTermsDays} onChange={set('paymentTermsDays')} />
              </Field>
              <Field label="Due date" htmlFor="doc-due" error={fields.dueDate} hint="Leave empty to work it out from the terms.">
                <Input id="doc-due" type="date" value={v.dueDate} onChange={set('dueDate')} />
              </Field>
            </>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Lines</h2>
          {offerFromJob && mode === 'create' && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" className="size-5" checked={fromJob} onChange={(e) => setFromJob(e.target.checked)} />
              Fill the lines from this job’s recommended work
            </label>
          )}
        </div>
        {fromJob ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-sm text-muted">The lines will be taken from the job’s recommended work (estimated labour and parts) when you save. You can adjust them afterwards. Nothing is approved by creating a quote.</p>
        ) : (
          <>
            {fields.lines && <Alert>{fields.lines}</Alert>}
            <ul className="space-y-3">
              {lines.map((l, i) => {
                // The server reports a field under its schema name or its calculation name; accept either.
                const f = (...ks: string[]) => ks.map((k) => fields[`lines.${i}.${k}`]).find(Boolean);
                return (
                  <li key={l.key} className="rounded-xl border border-line bg-canvas p-3">
                    <div className="grid gap-2 sm:grid-cols-6">
                      <div className="sm:col-span-4">
                        <Field label={`Line ${i + 1}: description`} htmlFor={`${l.key}-d`} error={f('description')}>
                          <Input id={`${l.key}-d`} value={l.description} onChange={(e) => patchLine(l.key, { description: e.target.value })} maxLength={300} placeholder="What is it?" />
                        </Field>
                      </div>
                      <div className="sm:col-span-2">
                        <Field label="Type" htmlFor={`${l.key}-t`}>
                          <Select id={`${l.key}-t`} value={l.lineType} onChange={(e) => patchLine(l.key, { lineType: e.target.value as LineState['lineType'] })}>
                            <option value="PART">Part</option><option value="LABOUR">Labour</option><option value="SERVICE">Service</option><option value="CHARGE">Additional charge</option><option value="OTHER">Other</option>
                          </Select>
                        </Field>
                      </div>
                      <Field label={l.lineType === 'LABOUR' ? 'Hours' : 'Quantity'} htmlFor={`${l.key}-q`} error={f('quantity', 'quantityMilli')}>
                        <Input id={`${l.key}-q`} inputMode="decimal" value={l.qty} onChange={(e) => patchLine(l.key, { qty: e.target.value })} />
                      </Field>
                      <Field label={l.lineType === 'LABOUR' ? 'Rate per hour' : 'Unit price'} htmlFor={`${l.key}-p`} error={f('unitPrice', 'unitPriceCents')} hint={tax.pricesIncludeVat ? 'Includes VAT' : tax.vatRegistered ? 'Excludes VAT' : undefined}>
                        <Input id={`${l.key}-p`} inputMode="decimal" value={l.price} onChange={(e) => patchLine(l.key, { price: e.target.value })} placeholder="0.00" />
                      </Field>
                      <Field label="Discount" htmlFor={`${l.key}-dt`}>
                        <Select id={`${l.key}-dt`} value={l.discountType} onChange={(e) => patchLine(l.key, { discountType: e.target.value as LineState['discountType'], discount: '' })}>
                          <option value="NONE">None</option><option value="PERCENT">Percent</option><option value="FIXED">Amount</option>
                        </Select>
                      </Field>
                      {l.discountType !== 'NONE' && (
                        <Field label={l.discountType === 'PERCENT' ? 'Percent off' : 'Amount off'} htmlFor={`${l.key}-dv`} error={f('discount', 'discountValue')}>
                          <Input id={`${l.key}-dv`} inputMode="decimal" value={l.discount} onChange={(e) => patchLine(l.key, { discount: e.target.value })} />
                        </Field>
                      )}
                      {tax.vatRegistered && (
                        <Field label="VAT" htmlFor={`${l.key}-v`}>
                          <Select id={`${l.key}-v`} value={l.taxTreatment} onChange={(e) => patchLine(l.key, { taxTreatment: e.target.value as LineState['taxTreatment'] })}>
                            <option value="STANDARD">Standard rate</option><option value="ZERO_RATED">Zero-rated</option><option value="EXEMPT">Exempt</option>
                          </Select>
                        </Field>
                      )}
                      <Field label="Part no. / ref (optional)" htmlFor={`${l.key}-s`}>
                        <Input id={`${l.key}-s`} value={l.sku} onChange={(e) => patchLine(l.key, { sku: e.target.value })} maxLength={60} />
                      </Field>
                      {canSeeCosts && (
                        <Field label="Cost per unit (private)" htmlFor={`${l.key}-c`} hint="Never shown to the customer.">
                          <Input id={`${l.key}-c`} inputMode="decimal" value={l.cost} onChange={(e) => patchLine(l.key, { cost: e.target.value })} placeholder="0.00" />
                        </Field>
                      )}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <p className="text-xs text-muted tabular-nums">
                        {hasPreview && preview.lines[i] ? `Line total ${money(preview.lines[i]!.totalCents)}` : ''}
                      </p>
                      <Button type="button" variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>Remove</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap gap-2">
              {canPickParts && <Button type="button" variant="secondary" onClick={() => setPicking((p) => !p)} aria-expanded={picking}>Add from stock</Button>}
              {([['PART', 'Add part'], ['LABOUR', 'Add labour'], ['SERVICE', 'Add service'], ['CHARGE', 'Add charge']] as const).map(([t, label]) => (
                <Button key={t} type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine({ lineType: t, unit: t === 'LABOUR' ? 'h' : '' })])}>{label}</Button>
              ))}
            </div>
            {services && services.length > 0 && (
              <div className="max-w-sm">
                <Field label="Add a service from your catalogue" htmlFor="doc-svc">
                  <Select id="doc-svc" value="" onChange={(e) => {
                    const s = services.find((x) => x.id === e.target.value);
                    if (s) setLines((ls) => [...ls, newLine({ lineType: 'SERVICE', description: s.name, price: (s.priceCents / 100).toFixed(2), taxTreatment: s.taxTreatment as LineState['taxTreatment'] })]);
                  }}>
                    <option value="">Choose a service…</option>
                    {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            {canPickParts && picking && (
              <div className="rounded-xl border border-dashed border-line p-3">
                <PartPicker
                  allowScan
                  onPick={(p) => {
                    setLines((ls) => [...ls, newLine({ lineType: 'PART', description: p.name, sku: p.sku, unit: p.unit === 'each' ? '' : p.unit, price: p.sellPriceCents === null ? '' : (p.sellPriceCents / 100).toFixed(2), taxTreatment: p.taxTreatment as LineState['taxTreatment'], inventoryItemId: p.id, cost: canSeeCosts && p.costCents !== null ? (p.costCents / 100).toFixed(2) : '' })]);
                    setPicking(false);
                  }}
                />
              </div>
            )}
          </>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-base font-semibold">Discount on the whole {kind}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type" htmlFor="doc-dt" error={fields.discountType}>
              <Select id="doc-dt" value={v.discountType} onChange={(e) => setV({ ...v, discountType: e.target.value as typeof v.discountType, discount: '' })}>
                <option value="NONE">None</option><option value="PERCENT">Percent</option><option value="FIXED">Amount</option>
              </Select>
            </Field>
            {v.discountType !== 'NONE' && (
              <Field label={v.discountType === 'PERCENT' ? 'Percent off' : 'Amount off'} htmlFor="doc-dv" error={fields.discount}>
                <Input id="doc-dv" inputMode="decimal" value={v.discount} onChange={set('discount')} />
              </Field>
            )}
          </div>
        </div>
        <div aria-live="polite" className="rounded-xl border border-line bg-surface p-3">
          <h2 className="mb-1 text-sm font-semibold">Totals preview</h2>
          {hasPreview ? (
            <dl className="space-y-0.5 text-sm tabular-nums">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{money(preview.subtotalCents)}</dd></div>
              {preview.discountCents > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd>−{money(preview.discountCents)}</dd></div>}
              {tax.vatRegistered && <div className="flex justify-between"><dt className="text-muted">VAT</dt><dd>{money(preview.vatCents)}</dd></div>}
              <div className="flex justify-between border-t border-line pt-1 text-base font-bold"><dt>Total</dt><dd>{money(preview.totalCents)}</dd></div>
            </dl>
          ) : preview && 'error' in preview ? (
            <p className="text-sm text-danger">{preview.error}</p>
          ) : (
            <p className="text-sm text-muted">Add a line to see the total.</p>
          )}
          <p className="mt-2 text-xs text-muted">The final amounts are calculated by the server when you save.</p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Notes and terms</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Notes for the customer" htmlFor="doc-cn" error={fields.customerNotes}>
            <Textarea id="doc-cn" rows={3} value={v.customerNotes} onChange={set('customerNotes')} maxLength={2000} />
          </Field>
          <Field label="Terms and conditions" htmlFor="doc-terms" error={fields.terms} hint="Defaults come from your finance settings.">
            <Textarea id="doc-terms" rows={3} value={v.terms} onChange={set('terms')} maxLength={4000} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Internal notes (never shown to the customer)" htmlFor="doc-in" error={fields.internalNotes}>
              <Textarea id="doc-in" rows={2} value={v.internalNotes} onChange={set('internalNotes')} maxLength={2000} />
            </Field>
          </div>
        </div>
      </section>

      {requireChangeNote && (
        <Alert tone="warn">
          This quote has already been sent. Saving creates a <strong>new version</strong>; the customer’s current version stays on record and can no longer be approved.
          <div className="mt-2">
            <Field label="What changed? (kept with the version)" htmlFor="doc-change" error={fields.changeNote}>
              <Input id="doc-change" value={v.changeNote} onChange={set('changeNote')} maxLength={500} />
            </Field>
          </div>
        </Alert>
      )}

      <div className={clsx('sticky bottom-16 z-10 -mx-3 border-t border-line bg-canvas/95 px-3 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0')}>
        <Button type="submit" loading={pending || !ready}>{submitLabel}</Button>
      </div>
    </form>
  );
}
