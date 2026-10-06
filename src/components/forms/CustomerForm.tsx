'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export interface CustomerFormValues {
  id?: string;
  type?: 'INDIVIDUAL' | 'BUSINESS';
  firstName?: string;
  lastName?: string;
  mobile?: string | null;
  email?: string | null;
  companyName?: string | null;
  companyRegNumber?: string | null;
  idNumber?: string | null;
  altPhone?: string | null;
  preferredContact?: string | null;
  marketingConsent?: boolean;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  notes?: string | null;
}

const TEXT = ['firstName', 'lastName', 'mobile', 'email', 'companyName', 'companyRegNumber', 'idNumber', 'altPhone', 'preferredContact', 'emergencyName', 'emergencyPhone', 'addressLine1', 'addressLine2', 'city', 'province', 'postalCode', 'notes'] as const;

/** Customer create/edit. Only the basics are required; everything else sits under "More details" so a quick add stays quick. */
export function CustomerForm({ initial = {}, canSubmit = true, returnTo }: { initial?: CustomerFormValues; canSubmit?: boolean; returnTo?: string }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const editing = !!initial.id;
  const [type, setType] = useState<'INDIVIDUAL' | 'BUSINESS'>(initial.type ?? 'INDIVIDUAL');
  const hasMore = !!(initial.idNumber || initial.altPhone || initial.emergencyName || initial.addressLine1 || initial.city || initial.notes || initial.preferredContact || initial.companyRegNumber);

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const body: Record<string, unknown> = { type, marketingConsent: (form.elements.namedItem('marketingConsent') as HTMLInputElement | null)?.checked ?? false };
        for (const f of TEXT) body[f] = formValue(form, f);
        void run(async () => {
          const res = editing
            ? await api<{ id: string }>(`/api/v1/customers/${initial.id}`, { method: 'PATCH', body })
            : await api<{ id: string }>('/api/v1/customers', { body });
          router.push(returnTo ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}customerId=${res.data.id}` : `/customers/${res.data.id}`);
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer type" htmlFor="type">
          <Select id="type" name="type" value={type} onChange={(e) => setType(e.target.value as 'INDIVIDUAL' | 'BUSINESS')}>
            <option value="INDIVIDUAL">Individual</option>
            <option value="BUSINESS">Business</option>
          </Select>
        </Field>
        {type === 'BUSINESS' ? (
          <Field label="Business name" htmlFor="companyName" error={fields.companyName}>
            <Input id="companyName" name="companyName" defaultValue={initial.companyName ?? ''} autoComplete="organization" aria-invalid={!!fields.companyName} />
          </Field>
        ) : <div className="hidden sm:block" />}
        <Field label="First name" htmlFor="firstName" error={fields.firstName}>
          <Input id="firstName" name="firstName" defaultValue={initial.firstName ?? ''} required autoFocus={!editing} autoComplete="given-name" aria-invalid={!!fields.firstName} />
        </Field>
        <Field label="Last name" htmlFor="lastName" error={fields.lastName}>
          <Input id="lastName" name="lastName" defaultValue={initial.lastName ?? ''} required autoComplete="family-name" aria-invalid={!!fields.lastName} />
        </Field>
        <Field label="Mobile number" htmlFor="mobile" error={fields.mobile}>
          <Input id="mobile" name="mobile" type="tel" inputMode="tel" defaultValue={initial.mobile ?? ''} required autoComplete="tel" aria-invalid={!!fields.mobile} />
        </Field>
        <Field label="Email" htmlFor="email" error={fields.email} hint="Needed to send booking and job emails.">
          <Input id="email" name="email" type="email" inputMode="email" defaultValue={initial.email ?? ''} autoComplete="email" aria-invalid={!!fields.email} />
        </Field>
      </div>

      <details open={hasMore} className="rounded-lg border border-line px-3 py-2">
        <summary className="min-h-10 cursor-pointer text-sm font-semibold leading-10">More details (optional)</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {type === 'BUSINESS' && (
            <Field label="Company registration number" htmlFor="companyRegNumber" error={fields.companyRegNumber}>
              <Input id="companyRegNumber" name="companyRegNumber" defaultValue={initial.companyRegNumber ?? ''} />
            </Field>
          )}
          <Field label="Alternative phone" htmlFor="altPhone" error={fields.altPhone}>
            <Input id="altPhone" name="altPhone" type="tel" inputMode="tel" defaultValue={initial.altPhone ?? ''} />
          </Field>
          <Field label="Preferred contact method" htmlFor="preferredContact">
            <Select id="preferredContact" name="preferredContact" defaultValue={initial.preferredContact ?? ''}>
              <option value="">No preference</option>
              <option value="PHONE">Phone call</option>
              <option value="SMS">SMS</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">Email</option>
            </Select>
          </Field>
          <Field label="ID number" htmlFor="idNumber" hint="Only if you legitimately need it.">
            <Input id="idNumber" name="idNumber" defaultValue={initial.idNumber ?? ''} autoComplete="off" />
          </Field>
          <Field label="Address" htmlFor="addressLine1">
            <Input id="addressLine1" name="addressLine1" defaultValue={initial.addressLine1 ?? ''} autoComplete="address-line1" />
          </Field>
          <Field label="Address line 2" htmlFor="addressLine2">
            <Input id="addressLine2" name="addressLine2" defaultValue={initial.addressLine2 ?? ''} autoComplete="address-line2" />
          </Field>
          <Field label="City / town" htmlFor="city">
            <Input id="city" name="city" defaultValue={initial.city ?? ''} autoComplete="address-level2" />
          </Field>
          <Field label="Province" htmlFor="province">
            <Input id="province" name="province" defaultValue={initial.province ?? ''} autoComplete="address-level1" />
          </Field>
          <Field label="Postal code" htmlFor="postalCode">
            <Input id="postalCode" name="postalCode" inputMode="numeric" defaultValue={initial.postalCode ?? ''} autoComplete="postal-code" />
          </Field>
          <Field label="Emergency contact name" htmlFor="emergencyName">
            <Input id="emergencyName" name="emergencyName" defaultValue={initial.emergencyName ?? ''} />
          </Field>
          <Field label="Emergency contact phone" htmlFor="emergencyPhone" error={fields.emergencyPhone}>
            <Input id="emergencyPhone" name="emergencyPhone" type="tel" inputMode="tel" defaultValue={initial.emergencyPhone ?? ''} />
          </Field>
        </div>
        <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="marketingConsent" defaultChecked={initial.marketingConsent} className="size-5" />
          The customer agreed to receive marketing messages
        </label>
        <div className="mt-2">
          <Field label="Notes" htmlFor="notes" error={fields.notes}>
            <Textarea id="notes" name="notes" defaultValue={initial.notes ?? ''} />
          </Field>
        </div>
      </details>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={pending || !ready} disabled={!canSubmit}>{editing ? 'Save changes' : 'Create customer'}</Button>
      </div>
    </form>
  );
}
