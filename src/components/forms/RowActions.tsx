'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

/**
 * A button that calls an API endpoint then refreshes the page. Destructive-ish
 * actions ask for confirmation first (inline, no modal).
 */
export function ActionButton({
  label,
  path,
  method = 'POST',
  body = {},
  variant = 'secondary',
  confirm,
  className,
}: {
  label: string;
  path: string;
  method?: string;
  body?: unknown;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  confirm?: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method, body });
      setAsking(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (asking && confirm) {
    return (
      <div className="space-y-2">
        <p className="text-sm">{confirm}</p>
        <div className="flex gap-2">
          <Button variant={variant === 'secondary' ? 'primary' : variant} loading={busy} onClick={go}>Yes, {label.toLowerCase()}</Button>
          <Button variant="secondary" onClick={() => setAsking(false)}>Cancel</Button>
        </div>
        {error && <Alert>{error}</Alert>}
      </div>
    );
  }

  return (
    <div className={className}>
      <Button variant={variant} loading={busy} onClick={() => (confirm ? setAsking(true) : void go())}>{label}</Button>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
    </div>
  );
}
