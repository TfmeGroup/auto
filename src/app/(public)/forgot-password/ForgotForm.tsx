'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function ForgotForm() {
  const { pending, ready, error, fields, run } = useSubmit();
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Check your email</h1>
        <p className="text-sm text-muted">If that address has an account, a password reset link is on its way. It expires in 1 hour.</p>
        <Link href="/login" className="text-sm font-medium text-brand-600 hover:underline">Back to sign in</Link>
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
        void run(async () => {
          await api('/api/v1/auth/forgot-password', { body: { email: formValue(form, 'email') } });
          setDone(true);
        });
      }}
      className="space-y-4"
    >
      <div>
        <h1 className="text-xl font-bold">Reset your password</h1>
        <p className="mt-1 text-sm text-muted">Enter your email and we will send you a link.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      <Field label="Email" htmlFor="email" error={fields.email}>
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required autoFocus aria-invalid={!!fields.email} />
      </Field>
      <Button type="submit" loading={pending || !ready} className="w-full">Send reset link</Button>
      <Link href="/login" className="block text-center text-sm text-brand-600 hover:underline">Back to sign in</Link>
    </form>
  );
}
