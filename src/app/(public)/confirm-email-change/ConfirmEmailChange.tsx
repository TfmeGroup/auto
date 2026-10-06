'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

/** Confirms on load (a POST, so link scanners that only fetch URLs cannot consume the token). */
export function ConfirmEmailChange({ token }: { token?: string }) {
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token ? 'working' : 'error');
  const [message, setMessage] = useState(token ? '' : 'This confirmation link is incomplete.');
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api('/api/v1/auth/confirm-email-change', { body: { token } })
      .then(() => setState('ok'))
      .catch((e) => {
        setMessage(e instanceof ApiError ? e.message : 'We could not confirm the change. Please try again.');
        setState('error');
      });
  }, [token]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Email address change</h1>
      {state === 'working' && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> Confirming…</p>}
      {state === 'ok' && (
        <>
          <Alert tone="ok">Your email address was changed. For your security you were signed out everywhere.</Alert>
          <Link href="/login" className="inline-block text-sm font-medium text-brand-600 hover:underline">Sign in with your new address</Link>
        </>
      )}
      {state === 'error' && (
        <>
          <Alert>{message}</Alert>
          <Link href="/login" className="inline-block text-sm font-medium text-brand-600 hover:underline">Go to sign in</Link>
        </>
      )}
    </div>
  );
}
