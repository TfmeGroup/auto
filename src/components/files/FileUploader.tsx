'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { ApiError } from '@/lib/api-client';

/**
 * Upload photos/documents to a record. "Take photo" opens the phone camera
 * directly; "Choose file" opens the file/gallery picker. Validation of type and
 * size is repeated authoritatively on the server.
 */
export function FileUploader({ resourceType, resourceId }: { resourceType: string; resourceId: string }) {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set('file', file);
        form.set('resourceType', resourceType);
        form.set('resourceId', resourceId);
        const res = await fetch('/api/v1/files', { method: 'POST', body: form, credentials: 'same-origin' });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new ApiError(res.status, 'UPLOAD', j.error?.message ?? 'Upload failed.');
        }
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed. Check your connection and try again.');
    } finally {
      setBusy(false);
      if (camera.current) camera.current.value = '';
      if (picker.current) picker.current.value = '';
    }
  }

  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="secondary" loading={busy} onClick={() => camera.current?.click()}>Take photo</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => picker.current?.click()}>Choose files</Button>
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void upload(e.target.files)} />
      <input
        ref={picker}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/gif,image/heic,application/pdf,.docx,.xlsx,.csv,.txt"
        className="hidden"
        onChange={(e) => void upload(e.target.files)}
      />
    </div>
  );
}
