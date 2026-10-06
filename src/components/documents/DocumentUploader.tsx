'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Badge, Button, Select, Textarea } from '@/components/ui';
import { formatBytes } from '@/lib/format';

/**
 * Add photos and documents to a record. "Take photo" opens the phone camera straight away; "Choose files" opens the gallery or file
 * picker and accepts several at once. Each file shows its own progress and its own result, so one failure never hides the others.
 * Type, size, ownership and storage limits are checked again, authoritatively, on the server: the checks here only save a round trip.
 */
type Status = { name: string; size: number; state: 'waiting' | 'uploading' | 'done' | 'failed'; progress: number; error?: string };

export interface CategoryChoice {
  key: string;
  label: string;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,application/pdf,.docx,.xlsx,.csv,.txt';

function send(file: File, fields: Record<string, string>, onProgress: (pct: number) => void): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.set('file', file);
    for (const [k, v] of Object.entries(fields)) if (v) form.set(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/files');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
      let message = 'The upload failed.';
      try { message = (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? message; } catch { /* keep the generic message */ }
      resolve({ ok: false, message });
    };
    xhr.onerror = () => resolve({ ok: false, message: 'The connection was lost. Check your signal and try again.' });
    xhr.send(form);
  });
}

export function DocumentUploader({
  resourceType, resourceId, categories, defaultCategory, canShare, canRestrict, photosOnly = false, maxMb,
}: {
  resourceType?: string;
  resourceId?: string;
  categories: CategoryChoice[];
  defaultCategory: string;
  canShare: boolean;
  canRestrict?: boolean;
  photosOnly?: boolean;
  maxMb: number;
}) {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState(defaultCategory);
  const [visibility, setVisibility] = useState<'INTERNAL' | 'CUSTOMER' | 'RESTRICTED'>('INTERNAL');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Status[]>([]);
  const [busy, setBusy] = useState(false);

  async function upload(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    setBusy(true);
    const state: Status[] = files.map((f) => ({ name: f.name, size: f.size, state: 'waiting', progress: 0 }));
    setRows(state);
    const patch = (i: number, p: Partial<Status>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...p } : r)));
    // Up to three at a time: quick on a good connection, kind to a weak one.
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        const f = files[i]!;
        if (f.size > maxMb * 1024 * 1024) { patch(i, { state: 'failed', error: `This file is ${formatBytes(f.size)}. The most you can upload is ${maxMb} MB.` }); continue; }
        patch(i, { state: 'uploading' });
        const r = await send(f, { resourceType: resourceType ?? '', resourceId: resourceId ?? '', category, visibility, description }, (pct) => patch(i, { progress: pct }));
        patch(i, r.ok ? { state: 'done', progress: 100 } : { state: 'failed', error: r.message });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setBusy(false);
    if (camera.current) camera.current.value = '';
    if (picker.current) picker.current.value = '';
    router.refresh();
  }

  const failed = rows.filter((r) => r.state === 'failed');
  return (
    <div className="space-y-3 rounded-lg border border-line bg-canvas p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="doc-category" className="mb-1 block text-xs font-medium">Category</label>
          <Select id="doc-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor="doc-visibility" className="mb-1 block text-xs font-medium">Who can see it</label>
          <Select id="doc-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
            <option value="INTERNAL">Staff only</option>
            {canShare && resourceType !== 'supplier' && resourceType !== 'employee' && <option value="CUSTOMER">Customer can see it</option>}
            {canRestrict && <option value="RESTRICTED">Restricted staff only</option>}
          </Select>
        </div>
        <div className="sm:col-span-1">
          <label htmlFor="doc-desc" className="mb-1 block text-xs font-medium">Description (optional)</label>
          <Textarea id="doc-desc" rows={1} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this?" />
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="secondary" loading={busy} onClick={() => camera.current?.click()}>Take photo</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => picker.current?.click()}>{photosOnly ? 'Choose photos' : 'Choose files'}</Button>
        <p className="self-center text-xs text-muted">Up to {maxMb} MB each. You can pick several.</p>
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-label="Take a photo" onChange={(e) => void upload(e.target.files)} />
      <input ref={picker} type="file" multiple accept={photosOnly ? 'image/jpeg,image/png,image/webp,image/gif,image/heic' : ACCEPT} className="sr-only" tabIndex={-1} aria-label="Choose files to upload" onChange={(e) => void upload(e.target.files)} />

      {rows.length > 0 && (
        <ul className="space-y-1.5" aria-live="polite">
          {rows.map((r, i) => (
            <li key={`${r.name}-${i}`} className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{r.name} <span className="text-xs text-muted">({formatBytes(r.size)})</span></span>
                {r.state === 'done' && <Badge tone="ok">Uploaded</Badge>}
                {r.state === 'failed' && <Badge tone="danger">Not uploaded</Badge>}
                {r.state === 'uploading' && <Badge tone="brand">{r.progress}%</Badge>}
                {r.state === 'waiting' && <Badge>Waiting</Badge>}
              </div>
              {r.state === 'uploading' && <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-line" role="progressbar" aria-valuenow={r.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${r.name}`}><div className="h-full bg-brand-600" style={{ width: `${r.progress}%` }} /></div>}
              {r.error && <p className="mt-1 text-xs font-medium text-danger">{r.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && !busy && <Alert>{failed.length === 1 ? '1 file was not uploaded.' : `${failed.length} files were not uploaded.`} The others were saved. Fix the problem shown and try those again.</Alert>}
    </div>
  );
}
