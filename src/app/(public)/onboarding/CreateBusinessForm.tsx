'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function CreateBusinessForm({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [vat, setVat] = useState(false);

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        void run(async () => {
          await api('/api/v1/businesses', {
            body: {
              name: formValue(form, 'name'),
              phone: formValue(form, 'phone'),
              city: formValue(form, 'city'),
              province: formValue(form, 'province'),
              vatRegistered: vat,
              vatNumber: vat ? formValue(form, 'vatNumber') : undefined,
            },
          });
          router.replace('/dashboard');
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      {error && <Alert>{error}</Alert>}
      <Field label="Business name" htmlFor="name" error={fields.name}>
        <Input id="name" name="name" autoComplete="organization" required autoFocus aria-invalid={!!fields.name} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone" htmlFor="phone" error={fields.phone}>
          <Input id="phone" name="phone" type="tel" autoComplete="tel" inputMode="tel" aria-invalid={!!fields.phone} />
        </Field>
        <Field label="City / town" htmlFor="city" error={fields.city}>
          <Input id="city" name="city" autoComplete="address-level2" />
        </Field>
      </div>
      <Field label="Province" htmlFor="province" error={fields.province}>
        <Input id="province" name="province" autoComplete="address-level1" />
      </Field>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} className="size-5 rounded border-line" />
        We are VAT registered
      </label>
      {vat && (
        <Field label="VAT number" htmlFor="vatNumber" error={fields.vatNumber}>
          <Input id="vatNumber" name="vatNumber" inputMode="numeric" aria-invalid={!!fields.vatNumber} />
        </Field>
      )}
      <Button type="submit" loading={pending || !ready} disabled={!canCreate} className="w-full">Create business</Button>
      <p className="text-center text-xs text-muted">Starts with a free trial. You become the Owner.</p>
    </form>
  );
}
