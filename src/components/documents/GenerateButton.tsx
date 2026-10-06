'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

/** Make (or open) a stored document from a record: a job summary, an inspection report, a purchase order, ... The file is real and filed in the document library. */
export function GenerateButton({ kind, id, label, regenerate = false, variant = 'secondary' }: { kind: string; id: string; label: string; regenerate?: boolean; variant?: 'primary' | 'secondary' }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ file: { id: string }; created: boolean }>('/api/v1/documents/generate', { body: { kind, id, regenerate, reason: regenerate ? reason : undefined } });
      router.push(`/documents/${r.data.file.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The document could not be made. Try again.');
      setBusy(false);
    }
  }

  if (regenerate && !asking) return <Button type="button" variant={variant} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <div className="space-y-2">
      {regenerate && (
        <div>
          <label htmlFor={`regen-${kind}`} className="mb-1 block text-xs font-medium">Why is a new version needed?</label>
          <input id={`regen-${kind}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm" placeholder="A few words, kept in the audit trail" />
        </div>
      )}
      <Button type="button" variant={variant} loading={busy} disabled={regenerate && reason.trim().length < 5} onClick={go}>{regenerate ? 'Make a new version' : label}</Button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
