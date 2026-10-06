'use client';

import { useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

/** Create a private link to the customer's job page. Anyone with the link can see what is marked for the customer, so share it with the customer only. */
export function CustomerLinkButton({ jobId }: { jobId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setError(null);
    try { setUrl((await api<{ url: string }>(`/api/v1/jobs/${jobId}/customer-link`, { body: {} })).data.url); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not create the link.'); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" loading={busy} onClick={go}>Create a customer link</Button>
      {error && <Alert>{error}</Alert>}
      {url && (
        <div className="rounded-lg border border-line bg-canvas p-3 text-sm">
          <p className="break-all font-mono text-xs">{url}</p>
          <p className="mt-1 text-xs text-muted">It shows only the updates, photos and documents you have marked for the customer. It is valid for 120 days.</p>
        </div>
      )}
    </div>
  );
}
