'use client';

import { useRouter } from 'next/navigation';
import { Alert, Button, Field, Input, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export interface SupplierDefaults {
  id?: string;
  name?: string;
  tradingName?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  accountNumber?: string | null;
  paymentTerms?: string | null;
  notes?: string | null;
}
const s = (v: string | null | undefined) => v ?? '';

export function SupplierForm({ mode, defaults = {} }: { mode: 'create' | 'edit'; defaults?: SupplierDefaults }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
        const body = Object.fromEntries(['name', 'tradingName', 'contactPerson', 'phone', 'email', 'address', 'vatNumber', 'registrationNumber', 'accountNumber', 'paymentTerms', 'notes'].map((k) => [k, v(k)]));
        void run(async () => {
          const r = await api<{ id: string }>(mode === 'create' ? '/api/v1/inventory/suppliers' : `/api/v1/inventory/suppliers/${defaults.id}`, { method: mode === 'create' ? 'POST' : 'PATCH', body });
          router.push(`/inventory/suppliers/${r.data.id ?? defaults.id}`);
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier name" htmlFor="sf-name" error={fields.name}><Input id="sf-name" name="name" required defaultValue={s(defaults.name)} aria-invalid={!!fields.name} /></Field>
        <Field label="Trading name" htmlFor="sf-trading"><Input id="sf-trading" name="tradingName" defaultValue={s(defaults.tradingName)} /></Field>
        <Field label="Contact person" htmlFor="sf-contact"><Input id="sf-contact" name="contactPerson" defaultValue={s(defaults.contactPerson)} /></Field>
        <Field label="Phone" htmlFor="sf-phone" error={fields.phone}><Input id="sf-phone" name="phone" type="tel" defaultValue={s(defaults.phone)} /></Field>
        <Field label="Email" htmlFor="sf-email" error={fields.email}><Input id="sf-email" name="email" type="email" defaultValue={s(defaults.email)} aria-invalid={!!fields.email} /></Field>
        <Field label="Our account / reference number" htmlFor="sf-acc"><Input id="sf-acc" name="accountNumber" defaultValue={s(defaults.accountNumber)} /></Field>
        <Field label="VAT number" htmlFor="sf-vat"><Input id="sf-vat" name="vatNumber" defaultValue={s(defaults.vatNumber)} /></Field>
        <Field label="Registration number" htmlFor="sf-reg"><Input id="sf-reg" name="registrationNumber" defaultValue={s(defaults.registrationNumber)} /></Field>
        <Field label="Payment terms" htmlFor="sf-terms"><Input id="sf-terms" name="paymentTerms" placeholder="e.g. 30 days from invoice" defaultValue={s(defaults.paymentTerms)} /></Field>
      </div>
      <Field label="Address" htmlFor="sf-addr"><Textarea id="sf-addr" name="address" rows={2} defaultValue={s(defaults.address)} /></Field>
      <Field label="Notes" htmlFor="sf-notes"><Textarea id="sf-notes" name="notes" defaultValue={s(defaults.notes)} /></Field>
      <div className="flex gap-2">
        <Button type="submit" loading={pending || !ready}>{mode === 'create' ? 'Add supplier' : 'Save changes'}</Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
