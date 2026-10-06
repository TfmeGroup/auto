'use client';

import { useRouter } from 'next/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function AddLocationForm() {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  return (
    <form
      method="post"
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        void run(async () => {
          await api('/api/v1/locations', { body: { name: formValue(f, 'name') } });
          f.reset();
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="New location name" htmlFor="locName" error={fields.name}><Input id="locName" name="name" required placeholder="e.g. Bellville branch" /></Field>
        <Button type="submit" loading={pending || !ready}>Add location</Button>
      </div>
    </form>
  );
}
