'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

export interface SessionRow {
  id: string;
  device: string;
  deviceType: string;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

const fmt = (d: string) => new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));

export function SessionsList({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(key: string, fn: () => Promise<unknown>, thenLogin = false) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (thenLogin) router.replace('/login');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <ul className="divide-y divide-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{s.device} <span className="text-xs font-normal text-muted">({s.deviceType})</span> {s.current && <Badge tone="ok">This device</Badge>}</p>
              <p className="text-xs text-muted">Last active {fmt(s.lastUsedAt)} · Signed in {fmt(s.createdAt)}{s.ip ? ` · IP ${s.ip}` : ''}</p>
            </div>
            <Button variant="ghost" loading={busy === s.id} onClick={() => void call(s.id, () => api(`/api/v1/account/sessions/${s.id}`, { method: 'DELETE', body: {} }), s.current)}>
              {s.current ? 'Sign out' : 'Sign out device'}
            </Button>
          </li>
        ))}
      </ul>
      {sessions.length > 1 && (
        <Button variant="secondary" loading={busy === 'others'} onClick={() => void call('others', () => api('/api/v1/account/sessions/revoke-others', { body: {} }))}>
          Sign out all other devices
        </Button>
      )}
    </div>
  );
}
