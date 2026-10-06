'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Select } from '@/components/ui';
import { ApiError } from '@/lib/api-client';

interface Preview {
  headers: string[];
  suggestedMapping: Record<string, string>;
  fields: { key: string; label: string; required: boolean }[];
  totals: { rows: number; valid: number; invalid: number; toCreate: number; toUpdate: number; priceChanges: number; newCategories: string[] };
  problems: { row: number; messages: string[] }[];
  sample: { row: number; sku: string; name: string; status: 'create' | 'update' | 'error' }[];
  committed?: { created: number; updated: number; skipped: number; failed: { row: number; message: string }[] };
}

/**
 * Import parts from CSV or Excel in the order the business asked for: choose the file, match the columns, check the preview, then confirm. The preview changes
 * nothing. Rows with problems are never imported quietly: they are listed, and the person must choose to skip them. Changing the price of parts that already exist
 * needs its own confirmation.
 */
export function ImportWizard({ canCost, canAdjust }: { canCost: boolean; canAdjust: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [onDuplicate, setOnDuplicate] = useState<'error' | 'update'>('error');
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [confirmPrices, setConfirmPrices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Preview['problems']>([]);

  async function send(mode: 'preview' | 'commit', map: Record<string, string>) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('mode', mode);
      form.set('mapping', JSON.stringify(map));
      form.set('onDuplicate', onDuplicate);
      form.set('skipInvalid', String(skipInvalid));
      form.set('confirmPriceChanges', String(confirmPrices));
      const res = await fetch('/api/v1/inventory/parts/import', { method: 'POST', body: form, credentials: 'same-origin' });
      const json = (await res.json().catch(() => ({}))) as { data?: Preview; error?: { message?: string; details?: { problems?: Preview['problems']; code?: string } } };
      if (!res.ok) {
        if (json.error?.details?.problems) setProblems(json.error.details.problems);
        throw new ApiError(res.status, json.error?.details?.code ?? 'ERROR', json.error?.message ?? 'The import failed.');
      }
      const data = json.data!;
      setPreview(data);
      if (mode === 'preview' && Object.keys(map).length === 0) setMapping(data.suggestedMapping);
      if (mode === 'commit') router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The file could not be sent. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Card className="space-y-3">
        <h2 className="text-base font-semibold">1. Choose a file</h2>
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setMapping({}); setProblems([]); }} className="block w-full text-sm" aria-label="File to import" />
        <p className="text-xs text-muted">A CSV or Excel (.xlsx) file with a header row, up to 5,000 rows and 8 MB. The first sheet is read. Costs{canCost ? '' : ' (you do not have permission to import costs)'} and opening quantities{canAdjust ? '' : ' (you do not have permission to adjust stock)'} are optional columns.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="When a SKU already exists" htmlFor="imp-dup"><Select id="imp-dup" value={onDuplicate} onChange={(e) => { setOnDuplicate(e.target.value as 'error' | 'update'); setPreview(null); }}><option value="error">Report it as a problem</option><option value="update">Update that part</option></Select></Field>
        </div>
        <Button type="button" loading={busy} disabled={!file} onClick={() => void send('preview', mapping)}>Check the file</Button>
      </Card>

      {preview && (
        <>
          <Card className="space-y-3">
            <h2 className="text-base font-semibold">2. Match the columns</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {preview.fields.filter((f) => (f.key !== 'cost' || canCost) && (f.key !== 'quantity' || canAdjust)).map((f) => (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} htmlFor={`map-${f.key}`}>
                  <Select id={`map-${f.key}`} value={mapping[f.key] ?? ''} onChange={(e) => { setMapping((m) => ({ ...m, [f.key]: e.target.value })); }}>
                    <option value="">Not in the file</option>{preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
            <Button type="button" variant="secondary" loading={busy} onClick={() => void send('preview', mapping)}>Update the preview</Button>
          </Card>

          <Card className="space-y-3">
            <h2 className="text-base font-semibold">3. Check the result</h2>
            <div className="flex flex-wrap gap-2"><Badge tone="ok">{preview.totals.valid} ready</Badge>{preview.totals.invalid > 0 && <Badge tone="danger">{preview.totals.invalid} with problems</Badge>}<Badge tone="brand">{preview.totals.toCreate} new</Badge>{preview.totals.toUpdate > 0 && <Badge tone="warn">{preview.totals.toUpdate} to update</Badge>}</div>
            {preview.totals.newCategories.length > 0 && <p className="text-sm">New categories will be created: {preview.totals.newCategories.join(', ')}.</p>}
            {preview.problems.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm">
                <ul className="space-y-1">{preview.problems.map((p) => <li key={p.row}><strong>Row {p.row}:</strong> {p.messages.join('; ')}</li>)}</ul>
                {preview.totals.invalid > preview.problems.length && <p className="mt-1 text-xs">…and {preview.totals.invalid - preview.problems.length} more.</p>}
              </div>
            )}
            <ul className="divide-y divide-line rounded-lg border border-line text-sm">{preview.sample.map((s) => <li key={s.row} className="flex items-center justify-between gap-2 px-3 py-1.5"><span className="truncate">Row {s.row}: {s.sku} — {s.name || '(no name)'}</span><Badge tone={s.status === 'error' ? 'danger' : s.status === 'update' ? 'warn' : 'ok'}>{s.status}</Badge></li>)}</ul>
          </Card>

          {!preview.committed && (
            <Card className="space-y-3">
              <h2 className="text-base font-semibold">4. Import</h2>
              {preview.totals.invalid > 0 && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />Skip the {preview.totals.invalid} row{preview.totals.invalid === 1 ? '' : 's'} with problems and import the rest</label>}
              {preview.totals.priceChanges > 0 && <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-5" checked={confirmPrices} onChange={(e) => setConfirmPrices(e.target.checked)} /><span><strong>{preview.totals.priceChanges} existing part{preview.totals.priceChanges === 1 ? '' : 's'}</strong> will get a new price or cost. The old values stay in each part&apos;s price history. I confirm these price changes.</span></label>}
              {problems.length > 0 && <Alert tone="warn">The server refused the import because of the problems listed above.</Alert>}
              <Button type="button" loading={busy} disabled={preview.totals.valid === 0 || (preview.totals.invalid > 0 && !skipInvalid) || (preview.totals.priceChanges > 0 && !confirmPrices)} onClick={() => void send('commit', mapping)}>Import {preview.totals.valid} part{preview.totals.valid === 1 ? '' : 's'}</Button>
            </Card>
          )}
          {preview.committed && (
            <Alert tone={preview.committed.failed.length ? 'warn' : 'ok'}>
              Imported: {preview.committed.created} created, {preview.committed.updated} updated{preview.committed.skipped ? `, ${preview.committed.skipped} skipped` : ''}.
              {preview.committed.failed.length > 0 && <> {preview.committed.failed.length} row{preview.committed.failed.length === 1 ? '' : 's'} could not be saved: {preview.committed.failed.slice(0, 5).map((f) => `row ${f.row} (${f.message})`).join('; ')}.</>}
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
