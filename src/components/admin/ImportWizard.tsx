'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

interface Kind { key: string; label: string; description: string; locked: boolean; fields: { key: string; label: string; required: boolean }[] }
interface Batch {
  id: string; kind: string; status: string; fileName: string; totalRows: number; validRows: number; invalidRows: number; duplicateRows: number; warningRows: number; importedRows: number; skippedRows: number; failedRows: number;
  headers: string[]; mapping?: Record<string, string>; suggestedMapping?: Record<string, string>; fields: { key: string; label: string; required: boolean }[];
  problems?: { row: number; status: string; messages: string[] }[];
}

const toBase64 = (buf: ArrayBuffer) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

/**
 * Upload -> choose type -> map columns -> validate -> preview -> confirm -> process -> results. Nothing is saved until the last button, and the
 * server re-checks every row at that moment. Rows with problems are listed with the reason; they are never imported or dropped silently.
 */
export function ImportWizard({ kinds, initialKind }: { kinds: Kind[]; initialKind?: string }) {
  const router = useRouter();
  const [kind, setKind] = useState(initialKind && kinds.some((k) => k.key === initialKind && !k.locked) ? initialKind : (kinds.find((k) => !k.locked)?.key ?? ''));
  const [batch, setBatch] = useState<Batch | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const k = kinds.find((x) => x.key === kind);

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(name); setError(null);
    try { return await fn(); } catch (e) { setError(e instanceof ApiError ? (Object.keys(e.fields).length ? Object.values(e.fields).join(' ') : e.message) : 'We could not reach the server.'); } finally { setBusy(null); }
  }

  const upload = (file: File) => step('upload', async () => {
    const content = toBase64(await file.arrayBuffer());
    const r = await api<Batch>('/api/v1/imports', { body: { kind, filename: file.name, content } });
    setBatch(r.data); setMapping(r.data.suggestedMapping ?? {});
  });
  const validate = () => step('validate', async () => { const r = await api<Batch>(`/api/v1/imports/${batch!.id}/validate`, { body: { mapping } }); setBatch(r.data); setMapping(r.data.mapping ?? mapping); });
  const commit = () => step('commit', async () => { const r = await api<Batch>(`/api/v1/imports/${batch!.id}/commit`, { body: { skipInvalid } }); setBatch(r.data); router.refresh(); });
  const cancel = () => step('cancel', async () => { await api(`/api/v1/imports/${batch!.id}`, { method: 'DELETE' }); setBatch(null); router.refresh(); });

  const done = batch && ['DONE', 'FAILED'].includes(batch.status);
  const validated = batch?.status === 'VALIDATED';
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}

      {!batch && (
        <Card>
          <h2 className="mb-3 text-base font-semibold">1. What are you importing?</h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {kinds.map((x) => (
              <label key={x.key} className={`flex min-h-11 cursor-pointer flex-col rounded-xl border p-3 text-sm ${kind === x.key ? 'border-brand-500 bg-brand-50' : 'border-line'} ${x.locked ? 'opacity-60' : ''}`}>
                <span className="flex items-center gap-2 font-medium"><input type="radio" name="kind" className="size-5" disabled={x.locked} checked={kind === x.key} onChange={() => setKind(x.key)} />{x.label}{x.locked && <Badge tone="warn">Higher plan</Badge>}</span>
                <span className="mt-1 text-xs text-muted">{x.description}</span>
              </label>
            ))}
          </div>
          <div className="mt-4">
            <Field label="2. Choose the file (CSV or Excel, up to 5,000 rows, first row = column names)" htmlFor="imp-file">
              <input id="imp-file" type="file" accept=".csv,.xlsx,.txt" className="block w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-sm" disabled={!k || busy === 'upload'} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            </Field>
            <p className="mt-2 text-xs text-muted">Nothing is saved when you upload. You will see exactly what would happen first.</p>
          </div>
        </Card>
      )}

      {batch && !done && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">3. Match your columns</h2>
          <p className="mb-3 text-sm text-muted">{batch.fileName} · {batch.totalRows.toLocaleString()} rows. Fields marked * are needed.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {batch.fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} htmlFor={`map-${f.key}`}>
                <Select id={`map-${f.key}`} value={mapping[f.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}>
                  <option value="">Not in my file</option>
                  {batch.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </Select>
              </Field>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" onClick={() => void validate()} loading={busy === 'validate'}>Check the file</Button>
            <Button type="button" variant="ghost" onClick={() => void cancel()} loading={busy === 'cancel'}>Cancel this import</Button>
          </div>
        </Card>
      )}

      {batch && validated && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">4. Preview</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[['Rows in the file', batch.totalRows, ''], ['Ready to import', batch.validRows, 'text-ok'], ['Have problems', batch.invalidRows, batch.invalidRows ? 'text-danger' : ''], ['Already exist (skipped)', batch.duplicateRows, batch.duplicateRows ? 'text-warn' : '']].map(([l, v, c]) => (
              <div key={String(l)} className="rounded-lg border border-line bg-canvas px-3 py-2"><dt className="text-xs uppercase tracking-wide text-muted">{l}</dt><dd className={`text-xl font-bold tabular-nums ${c}`}>{Number(v).toLocaleString()}</dd></div>
            ))}
          </dl>
          {batch.problems && batch.problems.length > 0 && (
            <div className="mt-3">
              <h3 className="mb-1 text-sm font-semibold">Rows that will not be imported</h3>
              <ul className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line p-2 text-sm">
                {batch.problems.map((p) => <li key={p.row}><span className="font-medium">Row {p.row}</span> <Badge tone={p.status === 'DUPLICATE' ? 'warn' : 'danger'}>{p.status === 'DUPLICATE' ? 'duplicate' : 'problem'}</Badge> {p.messages.join(' ')}</li>)}
              </ul>
              <p className="mt-1 text-xs text-muted">Duplicates are never merged or changed. <a className="font-medium text-brand-700 underline" href={`/api/v1/imports/${batch.id}/problems`}>Download these rows</a> to fix them and upload again.</p>
            </div>
          )}
          {batch.invalidRows > 0 && <label className="mt-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />Import the rows that are fine and skip the {batch.invalidRows} with problems</label>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" onClick={() => void commit()} loading={busy === 'commit'} disabled={batch.validRows === 0 || (batch.invalidRows > 0 && !skipInvalid)}>Import {batch.validRows.toLocaleString()} row{batch.validRows === 1 ? '' : 's'}</Button>
            <Button type="button" variant="secondary" onClick={() => setBatch({ ...batch, status: 'UPLOADED' })}>Change the matching</Button>
            <Button type="button" variant="ghost" onClick={() => void cancel()} loading={busy === 'cancel'}>Cancel</Button>
          </div>
        </Card>
      )}

      {done && batch && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">{batch.status === 'DONE' ? 'Import finished' : 'Import failed'}</h2>
          <p className="text-sm">{batch.importedRows.toLocaleString()} imported · {batch.skippedRows.toLocaleString()} skipped · {batch.duplicateRows.toLocaleString()} already existed · {batch.failedRows.toLocaleString()} failed.</p>
          {(batch.skippedRows + batch.duplicateRows + batch.failedRows) > 0 && <p className="mt-1 text-sm"><a className="font-medium text-brand-700 underline" href={`/api/v1/imports/${batch.id}/problems`}>Download the rows that were not imported</a>, with the reason for each.</p>}
          <div className="mt-3"><Button type="button" variant="secondary" onClick={() => { setBatch(null); }}>Import another file</Button></div>
        </Card>
      )}
    </div>
  );
}
