'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Input } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { api, ApiError } from '@/lib/api-client';

export interface CategoryRow {
  id?: string;
  key: string;
  label: string;
  builtin: boolean;
  active: boolean;
}

/** Retention and upload limits, and the business's own document categories. Financial retention can only be lengthened, never shortened. */
export function DocumentSettingsForm({ initial, categories, canManage, canCustomise, platformMax, financialFloor }: {
  initial: { trashRetentionDays: number; financialRetentionYears: number; maxUploadMb: number | null };
  categories: CategoryRow[];
  canManage: boolean;
  canCustomise: boolean;
  platformMax: number;
  financialFloor: number;
}) {
  const router = useRouter();
  const [s, setS] = useState({ trashRetentionDays: String(initial.trashRetentionDays), financialRetentionYears: String(initial.financialRetentionYears), maxUploadMb: initial.maxUploadMb === null ? '' : String(initial.maxUploadMb) });
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); router.refresh(); } catch (e) { setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'That did not work.' }); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!canCustomise && <Alert tone="warn">Custom categories and retention settings are included from the Team plan.</Alert>}
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void run('settings', () => api('/api/v1/files/settings', { method: 'PUT', body: { trashRetentionDays: Number(s.trashRetentionDays), financialRetentionYears: Number(s.financialRetentionYears), maxUploadMb: s.maxUploadMb === '' ? null : Number(s.maxUploadMb) } }), 'Settings saved.'); }}>
        <div>
          <label htmlFor="trash-days" className="mb-1 block text-sm font-medium">Days in the trash before permanent deletion</label>
          <Input id="trash-days" type="number" min={1} max={3650} value={s.trashRetentionDays} disabled={!canManage || !canCustomise} onChange={(e) => setS({ ...s, trashRetentionDays: e.target.value })} />
        </div>
        <div>
          <label htmlFor="fin-years" className="mb-1 block text-sm font-medium">Years to keep financial documents</label>
          <Input id="fin-years" type="number" min={financialFloor} max={50} value={s.financialRetentionYears} disabled={!canManage || !canCustomise} onChange={(e) => setS({ ...s, financialRetentionYears: e.target.value })} />
          <p className="mt-1 text-xs text-muted">Quotes, invoices, receipts, credit notes and statements cannot be permanently deleted before this. It can be lengthened but not shortened.</p>
        </div>
        <div>
          <label htmlFor="max-mb" className="mb-1 block text-sm font-medium">Largest upload (MB)</label>
          <Input id="max-mb" type="number" min={1} max={platformMax} value={s.maxUploadMb} placeholder={String(platformMax)} disabled={!canManage || !canCustomise} onChange={(e) => setS({ ...s, maxUploadMb: e.target.value })} />
          <p className="mt-1 text-xs text-muted">The system allows up to {platformMax} MB.</p>
        </div>
        {canManage && canCustomise && <div className="sm:col-span-3"><Button type="submit" loading={busy === 'settings'}>Save settings</Button></div>}
      </form>

      <section aria-labelledby="cats">
        <h3 id="cats" className="mb-2 text-sm font-semibold">Document categories</h3>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {categories.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>{c.label} <span className="text-xs text-muted">{c.builtin ? '(standard)' : c.active ? '(yours)' : '(yours, switched off)'}</span></span>
              {!c.builtin && c.id && canManage && canCustomise && <ActionButton label={c.active ? 'Switch off' : 'Switch on'} variant="ghost" path={`/api/v1/files/categories/${c.id}`} body={{ active: !c.active }} />}
            </li>
          ))}
        </ul>
        {canManage && canCustomise && (
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void run('cat', async () => { await api('/api/v1/files/categories', { body: { label } }); setLabel(''); }, 'Category added.'); }}>
            <div className="flex-1"><label htmlFor="new-cat" className="sr-only">New category name</label><Input id="new-cat" value={label} maxLength={40} placeholder="New category, e.g. Insurance claims" onChange={(e) => setLabel(e.target.value)} /></div>
            <Button type="submit" variant="secondary" loading={busy === 'cat'} disabled={label.trim().length < 2}>Add category</Button>
          </form>
        )}
      </section>
    </div>
  );
}
