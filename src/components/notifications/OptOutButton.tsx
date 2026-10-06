'use client';

import { useState } from 'react';
import { Alert, Button } from '@/components/ui';

export function OptOutButton({ token, label }: { token: string; label: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  async function go() {
    setState('busy');
    try {
      const res = await fetch(`/api/public/optout/${token}`, { method: 'POST', credentials: 'same-origin' });
      setState(res.ok ? 'done' : 'failed');
    } catch {
      setState('failed');
    }
  }
  if (state === 'done') return <Alert tone="ok">Done. You will no longer receive {label}.</Alert>;
  return (
    <div className="space-y-2">
      {state === 'failed' && <Alert>That did not work. Please try again.</Alert>}
      <Button type="button" loading={state === 'busy'} onClick={go}>Yes, stop {label}</Button>
    </div>
  );
}
