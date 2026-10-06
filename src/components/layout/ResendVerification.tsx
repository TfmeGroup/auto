'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';

export function ResendVerification() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  async function send() {
    setState('sending');
    try {
      await api('/api/v1/auth/resend-verification', { method: 'POST', body: {} });
      setState('sent');
    } catch {
      setState('error');
    }
  }
  if (state === 'sent') return <span>Verification email sent. Check your inbox.</span>;
  return (
    <span>
      Please verify your email address to create or join businesses.{' '}
      <button type="button" onClick={send} disabled={state === 'sending'} className="font-semibold underline">
        {state === 'sending' ? 'Sending…' : state === 'error' ? 'Try again' : 'Resend email'}
      </button>
    </span>
  );
}
