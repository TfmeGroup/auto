'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, safeNext, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function RegisterForm({ next }: { next?: string }) {
  const { pending, ready, error, fields, run } = useSubmit();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const loginHref = next ? `/login?next=${encodeURIComponent(safeNext(next))}` : '/login';

  if (sentTo) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Check your email</h1>
        <p className="text-sm text-muted">
          If <strong className="text-ink">{sentTo}</strong> can be registered, we have sent a link to confirm it. The link expires in 24 hours.
        </p>
        {next && <p className="text-sm text-muted">After you verify, open your invitation link again and accept it.</p>}
        <Link href={loginHref} className="text-sm font-medium text-brand-600 hover:underline">Back to sign in</Link>
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
        const email = formValue(form, 'email');
        void run(async () => {
          await api('/api/v1/auth/register', {
            body: { firstName: formValue(form, 'firstName'), lastName: formValue(form, 'lastName'), mobile: formValue(form, 'mobile'), email, password: formValue(form, 'password') },
          });
          setSentTo(email);
        });
      }}
      className="space-y-4"
    >
      <div>
        <h1 className="text-xl font-bold">Create your account</h1>
        <p className="mt-1 text-sm text-muted">Free, and personal to you. You will set up or join a workshop next.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="firstName" error={fields.firstName}>
          <Input id="firstName" name="firstName" autoComplete="given-name" required autoFocus aria-invalid={!!fields.firstName} />
        </Field>
        <Field label="Last name" htmlFor="lastName" error={fields.lastName}>
          <Input id="lastName" name="lastName" autoComplete="family-name" required aria-invalid={!!fields.lastName} />
        </Field>
      </div>
      <Field label="Email" htmlFor="email" error={fields.email}>
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required aria-invalid={!!fields.email} />
      </Field>
      <Field label="Mobile number (optional)" htmlFor="mobile" error={fields.mobile}>
        <Input id="mobile" name="mobile" type="tel" autoComplete="tel" inputMode="tel" aria-invalid={!!fields.mobile} />
      </Field>
      <Field label="Password" htmlFor="password" error={fields.password} hint="At least 10 characters. A passphrase works well.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required aria-invalid={!!fields.password} />
      </Field>
      <Button type="submit" loading={pending || !ready} className="w-full">Create account</Button>
      <p className="text-center text-sm text-muted">
        Already registered? <Link href={loginHref} className="font-medium text-brand-600 hover:underline">Sign in</Link>
      </p>
    </form>
  );
}
