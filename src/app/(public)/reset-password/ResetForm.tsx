'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function ResetForm({ token }: { token: string }) {
  const { pending, ready, error, fields, run } = useSubmit();
  const [done, setDone] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  if (done) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Password updated</h1>
        <p className="text-sm text-muted">You have been signed out everywhere. Sign in with your new password.</p>
        <Link href="/login" className="inline-block text-sm font-medium text-brand-600 hover:underline">Continue to sign in</Link>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const password = formValue(form, 'password');
        if (password !== formValue(form, 'confirm')) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        void run(async () => {
          await api('/api/v1/auth/reset-password', { body: { token, password } });
          setDone(true);
        });
      }}
      className="space-y-4"
    >
      <h1 className="text-xl font-bold">Choose a new password</h1>
      {error && <Alert>{error}</Alert>}
      <Field label="New password" htmlFor="password" error={fields.password} hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required autoFocus aria-invalid={!!fields.password} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={mismatch ? 'The two passwords do not match.' : undefined}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required aria-invalid={mismatch} />
      </Field>
      <Button type="submit" loading={pending || !ready} className="w-full">Update password</Button>
    </form>
  );
}
