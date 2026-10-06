'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

/** Confirms on load (a POST, so mail scanners that only fetch links cannot consume the token). */
export function VerifyEmail({ token }: { token?: string }) {
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token ? 'working' : 'error');
  const [message, setMessage] = useState(token ? '' : 'This verification link is incomplete.');
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api('/api/v1/auth/verify-email', { body: { token } })
      .then(() => setState('ok'))
      .catch((e) => {
        setMessage(e instanceof ApiError ? e.message : 'We could not verify your email. Please try again.');
        setState('error');
      });
  }, [token]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Email verification</h1>
      {state === 'working' && (
        <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> Verifying…</p>
      )}
      {state === 'ok' && (
        <>
          <Alert tone="ok">Your email address is verified.</Alert>
          <Link href="/dashboard" className="inline-block text-sm font-medium text-brand-600 hover:underline">Continue</Link>
        </>
      )}
      {state === 'error' && (
        <>
          <Alert>{message}</Alert>
          <p className="text-sm text-muted">Sign in and use “Resend email” to get a fresh link.</p>
          <Link href="/login" className="inline-block text-sm font-medium text-brand-600 hover:underline">Go to sign in</Link>
        </>
      )}
    </div>
  );
}
