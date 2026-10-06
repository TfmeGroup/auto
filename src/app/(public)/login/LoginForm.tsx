'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, safeNext, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

interface LoginResponse {
  mfaRequired: boolean;
  challengeToken?: string;
}

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  // The MFA challenge token lives only in memory for this page: never in browser storage.
  const [challenge, setChallenge] = useState<string | null>(null);

  const done = () => {
    router.replace(safeNext(next));
    router.refresh();
  };

  if (challenge) {
    return (
      <form
        method="post"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          void run(async () => {
            await api('/api/v1/auth/mfa/verify', { body: { challengeToken: challenge, code: formValue(form, 'code') } });
            done();
          });
        }}
        className="space-y-4"
      >
        <div>
          <h1 className="text-xl font-bold">Two-factor authentication</h1>
          <p className="mt-1 text-sm text-muted">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
        </div>
        {error && <Alert>{error}</Alert>}
        <Field label="Code" htmlFor="code" error={fields.code}>
          <Input id="code" name="code" autoComplete="one-time-code" inputMode="text" autoFocus required aria-invalid={!!fields.code} />
        </Field>
        <Button type="submit" loading={pending || !ready} className="w-full">Verify</Button>
        <button type="button" onClick={() => setChallenge(null)} className="block w-full text-center text-sm text-brand-600 hover:underline">Use a different account</button>
      </form>
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
          const res = await api<LoginResponse>('/api/v1/auth/login', { body: { email: formValue(form, 'email'), password: formValue(form, 'password') } });
          if (res.data.mfaRequired && res.data.challengeToken) setChallenge(res.data.challengeToken);
          else done();
        });
      }}
      className="space-y-4"
    >
      <div>
        <h1 className="text-xl font-bold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Welcome back. Enter your details to continue.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      <Field label="Email" htmlFor="email" error={fields.email}>
        <Input id="email" name="email" type="email" autoComplete="username" inputMode="email" autoFocus required aria-invalid={!!fields.email} />
      </Field>
      <Field label="Password" htmlFor="password" error={fields.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!fields.password} />
      </Field>
      <Button type="submit" loading={pending || !ready} className="w-full">Sign in</Button>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <Link href="/forgot-password" className="text-brand-600 hover:underline">Forgot password?</Link>
        <Link href={next ? `/register?next=${encodeURIComponent(safeNext(next))}` : '/register'} className="text-brand-600 hover:underline">Create an account</Link>
      </div>
    </form>
  );
}
