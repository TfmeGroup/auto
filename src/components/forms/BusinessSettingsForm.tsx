'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api, ApiError } from '@/lib/api-client';

export interface BusinessValues {
  name: string;
  tradingName: string | null;
  legalName: string | null;
  businessType: string | null;
  registrationNumber: string | null;
  vatRegistered: boolean;
  vatNumber: string | null;
  vatRateBps: number;
  currency: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingProvince: string | null;
  billingPostalCode: string | null;
  timezone: string;
  hasLogo: boolean;
}

const TYPES = ['Independent workshop', 'Franchise / dealership', 'Tyre & battery centre', 'Panel beater / body shop', 'Fleet maintenance', 'Mobile mechanic', 'Specialist (e.g. diesel, auto-electrical)', 'Other'];
const TEXT = ['name', 'tradingName', 'legalName', 'registrationNumber', 'phone', 'email', 'website', 'addressLine1', 'addressLine2', 'city', 'province', 'postalCode', 'billingAddressLine1', 'billingAddressLine2', 'billingCity', 'billingProvince', 'billingPostalCode'] as const;

export function LogoUploader({ hasLogo, canEdit }: { hasLogo: boolean; canEdit: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('logo', file);
      const res = await fetch('/api/v1/business/logo', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(res.status, 'UPLOAD', ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? 'Upload failed.');
      setVersion((v) => v + 1);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      {hasLogo || version > 0 ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/v1/business/logo?v=${version}`} alt="Business logo" className="h-16 max-w-40 rounded-lg border border-line object-contain p-1" />
      ) : (
        <span className="grid h-16 w-24 place-items-center rounded-lg border border-dashed border-line text-xs text-muted">No logo</span>
      )}
      {canEdit && (
        <div className="space-y-1">
          <Button type="button" variant="secondary" loading={busy} onClick={() => input.current?.click()}>{hasLogo ? 'Change logo' : 'Upload logo'}</Button>
          <p className="text-xs text-muted">JPG, PNG or WebP.</p>
          {error && <Alert>{error}</Alert>}
        </div>
      )}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
    </div>
  );
}

export function BusinessSettingsForm({ initial, canEdit }: { initial: BusinessValues; canEdit: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [saved, setSaved] = useState(false);
  const [vat, setVat] = useState(initial.vatRegistered);
  const v = (k: (typeof TEXT)[number]) => (initial[k] as string | null) ?? '';
  const f = (id: (typeof TEXT)[number], label: string, extra: Record<string, string> = {}) => (
    <Field label={label} htmlFor={id} error={fields[id]}>
      <Input id={id} name={id} defaultValue={v(id)} aria-invalid={!!fields[id]} {...extra} />
    </Field>
  );

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setSaved(false);
        void run(async () => {
          const rate = Number(formValue(form, 'vatRate').replace(',', '.'));
          const body: Record<string, unknown> = { vatRegistered: vat, vatNumber: formValue(form, 'vatNumber'), businessType: formValue(form, 'businessType') };
          for (const k of TEXT) body[k] = formValue(form, k);
          if (vat && Number.isFinite(rate)) body.vatRateBps = Math.round(rate * 100);
          await api('/api/v1/business', { method: 'PATCH', body });
          setSaved(true);
          router.refresh();
        });
      }}
      className="space-y-6"
    >
      {error && <Alert>{error}</Alert>}
      {saved && <Alert tone="ok">Settings saved.</Alert>}
      <fieldset disabled={!canEdit} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {f('name', 'Business name')}
          {f('tradingName', 'Trading name')}
          {f('legalName', 'Legal / registered name')}
          <Field label="Business type" htmlFor="businessType">
            <Select id="businessType" name="businessType" defaultValue={initial.businessType ?? ''}>
              <option value="">Select…</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          {f('registrationNumber', 'Registration number')}
          {f('phone', 'Phone', { type: 'tel', inputMode: 'tel' })}
          {f('email', 'Business email', { type: 'email', inputMode: 'email' })}
          {f('website', 'Website', { type: 'url', inputMode: 'url', placeholder: 'https://' })}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Physical address</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {f('addressLine1', 'Address')}{f('addressLine2', 'Address line 2')}{f('city', 'City / town')}{f('province', 'Province')}{f('postalCode', 'Postal code', { inputMode: 'numeric' })}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Billing address <span className="font-normal text-muted">(if different)</span></h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {f('billingAddressLine1', 'Address')}{f('billingAddressLine2', 'Address line 2')}{f('billingCity', 'City / town')}{f('billingProvince', 'Province')}{f('billingPostalCode', 'Postal code', { inputMode: 'numeric' })}
          </div>
        </div>

        <div className="space-y-4">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} className="size-5 rounded border-line" />
            VAT registered
          </label>
          {vat && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="VAT number" htmlFor="vatNumber" error={fields.vatNumber}><Input id="vatNumber" name="vatNumber" inputMode="numeric" defaultValue={initial.vatNumber ?? ''} /></Field>
              <Field label="VAT rate (%)" htmlFor="vatRate" hint="South Africa's standard rate is 15%."><Input id="vatRate" name="vatRate" inputMode="decimal" defaultValue={String(initial.vatRateBps / 100)} /></Field>
            </div>
          )}
        </div>
      </fieldset>
      <p className="text-xs text-muted">Currency: {initial.currency} · Timezone: {initial.timezone}</p>
      {canEdit && <div className="flex justify-end"><Button type="submit" loading={pending || !ready}>Save settings</Button></div>}
    </form>
  );
}
