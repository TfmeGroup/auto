'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Input, Select, Textarea } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { api, ApiError } from '@/lib/api-client';

interface Props {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  category: string;
  visibility: 'INTERNAL' | 'CUSTOMER' | 'RESTRICTED';
  status: string;
  categories: { key: string; label: string }[];
  can: { download: boolean; edit: boolean; delete: boolean; share: boolean; purge: boolean; upload: boolean; restricted: boolean };
  locked: boolean; // a financial document: its category is fixed and it cannot be trashed
  generated: boolean;
  shareable: boolean;
  writable: boolean;
}

/** Everything a person can do to one stored document. Each action is enforced again by the server; hiding a button here is only a courtesy. */
export function DocumentActions(p: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [form, setForm] = useState({ displayName: p.displayName ?? '', description: p.description ?? '', category: p.category });
  const fileInput = useRef<HTMLInputElement>(null);

  async function run<T>(key: string, fn: () => Promise<T>, ok?: string) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      if (ok) setMsg({ tone: 'ok', text: ok });
      router.refresh();
      return r;
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'That did not work. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function replace(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    await run('version', async () => {
      const form = new FormData();
      form.set('file', f);
      const res = await fetch(`/api/v1/files/${p.id}/versions`, { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new ApiError(res.status, 'UPLOAD', j.error?.message ?? 'The upload failed.');
      }
      const j = (await res.json()) as { data: { id: string } };
      router.push(`/documents/${j.data.id}`);
    }, 'The new version was saved. The earlier one is kept.');
    if (fileInput.current) fileInput.current.value = '';
  }

  const active = p.status === 'ACTIVE';
  return (
    <div className="space-y-5">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div className="flex flex-wrap gap-2">
        {p.can.download && <a href={`/api/v1/files/${p.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10">Open</a>}
        {p.can.download && <a href={`/api/v1/files/${p.id}?download=1`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10">Download</a>}
        {p.can.download && (
          <Button type="button" variant="secondary" loading={busy === 'link'} onClick={() => run('link', async () => { const r = await api<{ url: string; expiresAt: string }>(`/api/v1/files/${p.id}/link`, { body: {} }); setLink(r.data); })}>
            Get a 5-minute link
          </Button>
        )}
      </div>
      {link && (
        <div className="rounded-lg border border-line bg-canvas p-3 text-sm">
          <p className="font-medium">Temporary link (expires {new Date(link.expiresAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })})</p>
          <p className="mt-1 break-all font-mono text-xs">{link.url}</p>
          <p className="mt-1 text-xs text-muted">Anyone with this link can open the file until it expires, so only share it with someone you trust.</p>
        </div>
      )}

      {p.can.edit && p.writable && active && (
        <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void run('edit', () => api(`/api/v1/files/${p.id}`, { method: 'PATCH', body: { displayName: form.displayName, description: form.description, category: form.category } }), 'Details saved.'); }}>
          <h3 className="text-sm font-semibold">Details</h3>
          <div>
            <label htmlFor="d-name" className="mb-1 block text-xs font-medium">Name shown</label>
            <Input id="d-name" value={form.displayName} maxLength={150} placeholder={p.name} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </div>
          <div>
            <label htmlFor="d-cat" className="mb-1 block text-xs font-medium">Category</label>
            <Select id="d-cat" value={form.category} disabled={p.locked} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {p.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </Select>
            {p.locked && <p className="mt-1 text-xs text-muted">The category of a financial document is fixed.</p>}
          </div>
          <div>
            <label htmlFor="d-desc" className="mb-1 block text-xs font-medium">Description</label>
            <Textarea id="d-desc" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <Button type="submit" variant="secondary" loading={busy === 'edit'}>Save details</Button>
        </form>
      )}

      {p.can.edit && p.writable && active && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <h3 className="text-sm font-semibold">Who can see this</h3>
          <Select aria-label="Who can see this document" value={p.visibility} onChange={(e) => void run('vis', () => api(`/api/v1/files/${p.id}/visibility`, { body: { visibility: e.target.value } }), 'Visibility changed.')} disabled={busy === 'vis'}>
            <option value="INTERNAL">Staff only</option>
            {p.shareable && <option value="CUSTOMER" disabled={!p.can.share}>Customer can see it{p.can.share ? '' : ' (needs permission to share)'}</option>}
            {(p.can.restricted || p.visibility === 'RESTRICTED') && <option value="RESTRICTED" disabled={!p.can.restricted}>Restricted staff only</option>}
          </Select>
          <p className="text-xs text-muted">{p.shareable ? 'A customer sees a document only if you choose "Customer can see it", and only through their own private link.' : 'This kind of record is never shown to customers.'}</p>
        </div>
      )}

      {p.can.upload && p.can.edit && p.writable && active && !p.generated && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <h3 className="text-sm font-semibold">Replace with a new version</h3>
          <p className="text-xs text-muted">The current file stays in the version history.</p>
          <Button type="button" variant="secondary" loading={busy === 'version'} onClick={() => fileInput.current?.click()}>Choose the new file</Button>
          <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Choose the new version" onChange={(e) => void replace(e.target.files)} />
        </div>
      )}

      {p.writable && (
        <div className="flex flex-wrap items-start gap-2">
          {p.can.delete && active && <ActionButton label="Archive" path={`/api/v1/files/${p.id}/archive`} confirm="Archive this document? It stays available in the archive." />}
          {p.can.delete && !p.locked && (active || p.status === 'ARCHIVED') && <ActionButton label="Move to trash" variant="danger" path={`/api/v1/files/${p.id}/trash`} confirm="Move this document to the trash? You can restore it until it is permanently deleted." />}
          {p.can.delete && (p.status === 'ARCHIVED' || p.status === 'TRASHED') && <ActionButton label="Restore" path={`/api/v1/files/${p.id}/restore`} />}
          {p.can.purge && p.status === 'TRASHED' && <ActionButton label="Delete permanently" variant="danger" path={`/api/v1/files/${p.id}/purge`} confirm="Permanently delete this document? This cannot be undone." />}
        </div>
      )}
    </div>
  );
}
