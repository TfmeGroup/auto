'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api, ApiError } from '@/lib/api-client';
import { centsToDecimal, parseDecimalToCents } from '@/lib/money';

export interface SettingsView {
  quotePrefix: string; invoicePrefix: string; paymentPrefix: string; receiptPrefix: string; creditNotePrefix: string; refundPrefix: string; numberPadding: number;
  quoteValidityDays: number; paymentTermsDays: number; pricesIncludeVat: boolean; quoteTerms: string | null; invoiceTerms: string | null; invoiceFooter: string | null; paymentInstructions: string | null;
  enabledMethods: string[]; depositsEnabled: boolean; remindersEnabled: boolean; reminderOffsets: number[]; reminderRepeatDays: number; onlineSandbox: boolean;
  online: { availableProviders: { key: string; label: string; fields: { key: string; label: string; secret: boolean; required: boolean }[] }[]; provider: string | null; sandbox: boolean; entitled: boolean; configured: boolean; fields: { key: string; label: string; secret: boolean; required: boolean; isSet: boolean; value: string | null }[] };
  reminders: { entitled: boolean };
}

const METHODS = [['CARD', 'Card'], ['EFT', 'EFT'], ['CASH', 'Cash'], ['ONLINE', 'Online (recorded)'], ['OTHER', 'Other']] as const;

/** All the quote/invoice/payment settings in one form. Saved through the API, which enforces permission, plan and validation. */
export function FinanceSettingsForm({ s, vat }: { s: SettingsView; vat: { registered: boolean; rateBps: number } }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [saved, setSaved] = useState(false);
  const [v, setV] = useState({
    quotePrefix: s.quotePrefix, invoicePrefix: s.invoicePrefix, paymentPrefix: s.paymentPrefix, receiptPrefix: s.receiptPrefix, creditNotePrefix: s.creditNotePrefix, refundPrefix: s.refundPrefix,
    numberPadding: String(s.numberPadding), quoteValidityDays: String(s.quoteValidityDays), paymentTermsDays: String(s.paymentTermsDays), pricesIncludeVat: s.pricesIncludeVat,
    quoteTerms: s.quoteTerms ?? '', invoiceTerms: s.invoiceTerms ?? '', invoiceFooter: s.invoiceFooter ?? '', paymentInstructions: s.paymentInstructions ?? '',
    enabledMethods: s.enabledMethods, depositsEnabled: s.depositsEnabled, remindersEnabled: s.remindersEnabled, reminderOffsets: s.reminderOffsets.join(', '), reminderRepeatDays: String(s.reminderRepeatDays),
    onlineProvider: s.online.provider ?? '', onlineSandbox: s.onlineSandbox,
  });
  const [creds, setCreds] = useState<Record<string, string>>({});
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => { setSaved(false); setV({ ...v, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }); };
  const provider = s.online.availableProviders.find((p) => p.key === v.onlineProvider);
  const sameProvider = v.onlineProvider === (s.online.provider ?? '');

  return (
    <form
      method="post"
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const offsets = v.reminderOffsets.split(/[\s,;]+/).filter(Boolean).map(Number);
          const body: Record<string, unknown> = {
            quotePrefix: v.quotePrefix, invoicePrefix: v.invoicePrefix, paymentPrefix: v.paymentPrefix, receiptPrefix: v.receiptPrefix, creditNotePrefix: v.creditNotePrefix, refundPrefix: v.refundPrefix,
            numberPadding: Number(v.numberPadding), quoteValidityDays: Number(v.quoteValidityDays), paymentTermsDays: Number(v.paymentTermsDays), pricesIncludeVat: v.pricesIncludeVat,
            quoteTerms: v.quoteTerms, invoiceTerms: v.invoiceTerms, invoiceFooter: v.invoiceFooter, paymentInstructions: v.paymentInstructions,
            enabledMethods: v.enabledMethods, depositsEnabled: v.depositsEnabled, remindersEnabled: v.remindersEnabled, reminderOffsets: offsets, reminderRepeatDays: Number(v.reminderRepeatDays),
          };
          if (s.online.entitled) {
            body.onlineSandbox = v.onlineSandbox;
            if (v.onlineProvider !== (s.online.provider ?? '') || Object.values(creds).some((x) => x.trim() !== '') || (v.onlineProvider && !sameProvider)) {
              body.onlineProvider = v.onlineProvider;
              // Non-secret fields that were not touched are re-sent from what is saved, so only what changed needs typing.
              const prefill = sameProvider ? Object.fromEntries(s.online.fields.filter((x) => !x.secret && x.value).map((x) => [x.key, x.value as string])) : {};
              const sent = { ...(sameProvider ? {} : prefill), ...Object.fromEntries(Object.entries(creds).filter(([, x]) => x.trim() !== '')) };
              if (v.onlineProvider && Object.keys(sent).length) body.onlineCredentials = sent;
            }
          }
          await api('/api/v1/finance/settings', { method: 'PATCH', body });
          setSaved(true);
          setCreds({});
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {saved && !pending && !error && <Alert tone="ok">Settings saved.</Alert>}

      <Card className="space-y-3">
        <h2 className="text-base font-semibold">Document numbers</h2>
        <p className="text-sm text-muted">Numbers are generated by the server and never repeat. Changing a prefix only affects new documents; numbers already issued stay as they are.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {([['quotePrefix', 'Quotes'], ['invoicePrefix', 'Invoices'], ['paymentPrefix', 'Payments'], ['receiptPrefix', 'Receipts'], ['creditNotePrefix', 'Credit notes'], ['refundPrefix', 'Refunds']] as const).map(([k, label]) => (
            <Field key={k} label={`${label} prefix`} htmlFor={`s-${k}`} error={fields[k]}><Input id={`s-${k}`} value={v[k]} onChange={set(k)} maxLength={8} autoCapitalize="characters" /></Field>
          ))}
          <Field label="Digits in the number" htmlFor="s-pad" error={fields.numberPadding} hint={`e.g. ${v.invoicePrefix || 'INV'}-${'0'.repeat(Math.max(0, Number(v.numberPadding) - 1))}1`}><Input id="s-pad" inputMode="numeric" value={v.numberPadding} onChange={set('numberPadding')} /></Field>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-base font-semibold">Quotes and invoices</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Quotes are valid for (days)" htmlFor="s-qv" error={fields.quoteValidityDays}><Input id="s-qv" inputMode="numeric" value={v.quoteValidityDays} onChange={set('quoteValidityDays')} /></Field>
          <Field label="Invoices are due after (days)" htmlFor="s-pt" error={fields.paymentTermsDays}><Input id="s-pt" inputMode="numeric" value={v.paymentTermsDays} onChange={set('paymentTermsDays')} /></Field>
        </div>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-5" checked={v.pricesIncludeVat} onChange={set('pricesIncludeVat')} />
          <span>Prices I type include VAT<span className="block text-xs text-muted">{vat.registered ? `VAT is ${vat.rateBps / 100}% (set under Business). Existing documents keep the way they were priced.` : 'Your business is not VAT registered, so no VAT is charged. Set this under Business if that changes.'}</span></span>
        </label>
        <Field label="Default quote terms" htmlFor="s-qt" error={fields.quoteTerms}><Textarea id="s-qt" rows={3} value={v.quoteTerms} onChange={set('quoteTerms')} maxLength={4000} /></Field>
        <Field label="Default invoice terms" htmlFor="s-it" error={fields.invoiceTerms}><Textarea id="s-it" rows={3} value={v.invoiceTerms} onChange={set('invoiceTerms')} maxLength={4000} /></Field>
        <Field label="Invoice footer" htmlFor="s-if" error={fields.invoiceFooter} hint="One line at the bottom of every PDF."><Input id="s-if" value={v.invoiceFooter} onChange={set('invoiceFooter')} maxLength={500} /></Field>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-base font-semibold">Getting paid</h2>
        <Field label="Payment instructions (shown to customers)" htmlFor="s-pi" error={fields.paymentInstructions} hint="Bank name, account number, branch code and the reference to use, for customers who pay by EFT.">
          <Textarea id="s-pi" rows={3} value={v.paymentInstructions} onChange={set('paymentInstructions')} maxLength={2000} />
        </Field>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Payment methods you accept</legend>
          <p className="text-xs text-muted">Turning a method off does not change payments already recorded.</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {METHODS.map(([m, label]) => (
              <label key={m} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-5" checked={v.enabledMethods.includes(m)} onChange={(e) => { setSaved(false); setV({ ...v, enabledMethods: e.target.checked ? [...v.enabledMethods, m] : v.enabledMethods.filter((x) => x !== m) }); }} />
                {label}
              </label>
            ))}
          </div>
          {fields.enabledMethods && <p role="alert" className="text-xs font-medium text-danger">{fields.enabledMethods}</p>}
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={v.depositsEnabled} onChange={set('depositsEnabled')} /> Allow deposits and advance payments</label>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-base font-semibold">Payment reminders</h2>
        {!s.reminders.entitled && <Alert tone="warn">Automatic payment reminders are part of the Team plan and above.</Alert>}
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={v.remindersEnabled} disabled={!s.reminders.entitled} onChange={set('remindersEnabled')} /> Email customers about invoices that are due or overdue</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Send on these days from the due date" htmlFor="s-ro" error={fields.reminderOffsets} hint="Negative = before, 0 = on the day, positive = after. For example −3, 0, 7.">
            <Input id="s-ro" value={v.reminderOffsets} onChange={set('reminderOffsets')} disabled={!s.reminders.entitled} />
          </Field>
          <Field label="Then repeat every (days, 0 = never)" htmlFor="s-rr" error={fields.reminderRepeatDays}><Input id="s-rr" inputMode="numeric" value={v.reminderRepeatDays} onChange={set('reminderRepeatDays')} disabled={!s.reminders.entitled} /></Field>
        </div>
        <p className="text-xs text-muted">Reminders only go to invoices you have sent, are never marketing, respect the customer’s contact preference, and each one is sent once.</p>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-base font-semibold">Online payments</h2>
        {!s.online.entitled ? <Alert tone="warn">Online customer payments (a payment gateway) are part of the Team plan and above.</Alert> : (
          <>
            <p className="text-sm text-muted">Let customers pay an invoice by card from the link you send them. The money goes to <strong>your own</strong> merchant account with the provider; credentials are stored encrypted and never shown again.</p>
            <Field label="Payment provider" htmlFor="s-prov" error={fields.onlineProvider}>
              <Select id="s-prov" value={v.onlineProvider} onChange={(e) => { setSaved(false); setV({ ...v, onlineProvider: e.target.value }); setCreds({}); }}>
                <option value="">None: customers pay by EFT or at the workshop</option>
                {s.online.availableProviders.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Select>
            </Field>
            {provider && sameProvider && (
              <p className="text-sm">{s.online.configured ? <span className="font-medium text-ok">Connected.</span> : <span className="font-medium text-warn">Credentials are incomplete.</span>}</p>
            )}
            {provider && provider.fields.map((f) => {
              const known = sameProvider ? s.online.fields.find((x) => x.key === f.key) : undefined;
              return (
                <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} htmlFor={`s-c-${f.key}`} error={fields.onlineCredentials} hint={f.secret ? (known?.isSet ? 'Saved. Type a new value only to replace it.' : 'Not set yet.') : undefined}>
                  <Input id={`s-c-${f.key}`} type={f.secret ? 'password' : 'text'} autoComplete="off" value={creds[f.key] ?? (f.secret ? '' : known?.value ?? '')} placeholder={f.secret && known?.isSet ? '••••••••' : ''} onChange={(e) => { setSaved(false); setCreds({ ...creds, [f.key]: e.target.value }); }} />
                </Field>
              );
            })}
            {provider && (
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={v.onlineSandbox} onChange={set('onlineSandbox')} /> Use the provider’s test (sandbox) mode: no real money moves</label>
            )}
            {provider && (
              <p className="text-xs text-muted">Webhook (payment notification) address to give the provider: <span className="break-all font-mono">/api/webhooks/payments/{provider.key}/&lt;your business id&gt;</span>. It is added to each checkout automatically.</p>
            )}
          </>
        )}
      </Card>

      <div className="sticky bottom-16 z-10 -mx-3 border-t border-line bg-canvas/95 px-3 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
        <Button type="submit" loading={pending || !ready}>Save settings</Button>
      </div>
    </form>
  );
}

/** Technician cost rates, used only to work out gross profit on invoices. */
export function LabourRates({ rows }: { rows: { membershipId: string; name: string; roleName: string; labourCostCentsPerHour: number | null }[] }) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [r.membershipId, r.labourCostCentsPerHour === null ? '' : centsToDecimal(r.labourCostCentsPerHour)])));
  const [msg, setMsg] = useState<Record<string, string>>({});
  async function save(id: string) {
    try {
      const raw = (vals[id] ?? '').replace(/[Rr\s]/g, '').replace(',', '.');
      await api(`/api/v1/finance/labour-rates/${id}`, { method: 'PATCH', body: { labourCostCentsPerHour: raw === '' ? null : parseDecimalToCents(raw) } });
      setMsg({ ...msg, [id]: 'Saved' });
      router.refresh();
    } catch (e) {
      setMsg({ ...msg, [id]: e instanceof ApiError ? e.message : 'Enter a rand amount, e.g. 200.00' });
    }
  }
  if (rows.length === 0) return <p className="text-sm text-muted">No technicians yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.membershipId} className="flex flex-wrap items-end justify-between gap-3 py-3">
          <div className="min-w-0"><p className="text-sm font-medium">{r.name}</p><p className="text-xs text-muted">{r.roleName}</p></div>
          <div className="flex items-end gap-2">
            <Field label="Cost per hour" htmlFor={`lr-${r.membershipId}`}><Input id={`lr-${r.membershipId}`} inputMode="decimal" className="w-28" value={vals[r.membershipId] ?? ''} onChange={(e) => { setMsg({}); setVals({ ...vals, [r.membershipId]: e.target.value }); }} placeholder="0.00" /></Field>
            <Button type="button" variant="secondary" onClick={() => void save(r.membershipId)}>Save</Button>
          </div>
          {msg[r.membershipId] && <p role="status" className="w-full text-xs text-muted">{msg[r.membershipId]}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Document code per location (multi-location businesses). */
export function LocationCodes({ rows }: { rows: { id: string; name: string; docCode: string | null }[] }) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [r.id, r.docCode ?? ''])));
  const [msg, setMsg] = useState<Record<string, string>>({});
  async function save(id: string) {
    try {
      await api(`/api/v1/finance/locations/${id}`, { method: 'PATCH', body: { docCode: vals[id] ?? '' } });
      setMsg({ ...msg, [id]: 'Saved' });
      router.refresh();
    } catch (e) {
      setMsg({ ...msg, [id]: e instanceof ApiError ? e.message : 'Could not save.' });
    }
  }
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-end justify-between gap-3 py-3">
          <p className="text-sm font-medium">{r.name}</p>
          <div className="flex items-end gap-2">
            <Field label="Code" htmlFor={`lc-${r.id}`}><Input id={`lc-${r.id}`} className="w-28" value={vals[r.id] ?? ''} onChange={(e) => { setMsg({}); setVals({ ...vals, [r.id]: e.target.value.toUpperCase() }); }} maxLength={6} placeholder="e.g. CPT" /></Field>
            <Button type="button" variant="secondary" onClick={() => void save(r.id)}>Save</Button>
          </div>
          {msg[r.id] && <p role="status" className="w-full text-xs text-muted">{msg[r.id]}</p>}
        </li>
      ))}
    </ul>
  );
}
