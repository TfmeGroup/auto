'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { RecordStatusBadge, StockBadge, money, randToCentsOrNull, type MoneyFmt } from './shared';

export interface PartListItem {
  id: string;
  sku: string;
  partNumber: string | null;
  name: string;
  brand: string | null;
  categoryName: string | null;
  unit: string;
  costCents: number | null;
  sellPriceCents: number | null;
  onHand: number;
  reserved: number;
  available: number;
  state: string;
  status: string;
  primarySupplierName: string | null;
}

/**
 * The parts list: cards on a phone, a table on a desktop. When the person may change parts in bulk (and the plan allows it) rows can be ticked and one
 * change applied to all of them; price changes always show a preview of the new prices first and need a second confirmation.
 */
export function PartsList({ items, fmt, showCost, bulk, categories }: { items: PartListItem[]; fmt: MoneyFmt; showCost: boolean; bulk: boolean; categories: { value: string; label: string }[] }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const all = items.length > 0 && items.every((i) => picked.has(i.id));
  const Check = ({ id }: { id: string }) => bulk ? <input type="checkbox" className="size-5" checked={picked.has(id)} onChange={() => toggle(id)} aria-label="Select part" /> : null;

  return (
    <div className="space-y-3">
      {bulk && picked.size > 0 && <BulkBar ids={[...picked]} categories={categories} fmt={fmt} showCost={showCost} onDone={() => setPicked(new Set())} />}
      <ul className="space-y-2 md:hidden">
        {items.map((p) => (
          <li key={p.id} className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3 shadow-sm">
            {bulk && <div className="pt-1"><Check id={p.id} /></div>}
            <Link href={`/inventory/parts/${p.id}`} className="block min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2"><p className="min-w-0 truncate font-semibold">{p.name}</p><StockBadge state={p.state} /></div>
              <p className="truncate text-xs text-muted">{[p.sku, p.partNumber, p.brand].filter(Boolean).join(' · ')}</p>
              <div className="mt-1.5 flex items-end justify-between gap-2 text-sm">
                <span className="tabular-nums"><strong className={clsx(p.available <= 0 && 'text-danger')}>{p.available}</strong> available <span className="text-muted">({p.onHand} on hand{p.reserved ? `, ${p.reserved} reserved` : ''})</span></span>
                <span className="tabular-nums">{money(p.sellPriceCents, fmt)}</span>
              </div>
              {p.status !== 'ACTIVE' && <div className="mt-1"><RecordStatusBadge status={p.status} /></div>}
            </Link>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {bulk && <th className="w-10 px-3 py-2"><input type="checkbox" className="size-4" checked={all} onChange={() => setPicked(all ? new Set() : new Set(items.map((i) => i.id)))} aria-label="Select all on this page" /></th>}
              <th className="px-3 py-2 font-medium">Part</th><th className="px-3 py-2 font-medium">Category</th><th className="px-3 py-2 text-right font-medium">On hand</th><th className="px-3 py-2 text-right font-medium">Reserved</th>
              <th className="px-3 py-2 text-right font-medium">Available</th><th className="px-3 py-2 font-medium">Stock</th>{showCost && <th className="px-3 py-2 text-right font-medium">Cost</th>}<th className="px-3 py-2 text-right font-medium">Price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((p) => (
              <tr key={p.id} className="hover:bg-canvas">
                {bulk && <td className="px-3 py-2.5"><Check id={p.id} /></td>}
                <td className="px-3 py-2.5"><Link href={`/inventory/parts/${p.id}`} className="font-semibold text-brand-700 hover:underline">{p.name}</Link><span className="block text-xs text-muted">{[p.sku, p.partNumber, p.brand].filter(Boolean).join(' · ')}{p.status !== 'ACTIVE' ? ` · ${p.status.toLowerCase()}` : ''}</span></td>
                <td className="px-3 py-2.5 text-muted">{p.categoryName ?? '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{p.onHand}</td><td className="px-3 py-2.5 text-right tabular-nums">{p.reserved}</td>
                <td className={clsx('px-3 py-2.5 text-right font-semibold tabular-nums', p.available <= 0 && 'text-danger')}>{p.available}</td>
                <td className="px-3 py-2.5"><StockBadge state={p.state} /></td>
                {showCost && <td className="px-3 py-2.5 text-right tabular-nums">{money(p.costCents, fmt)}</td>}
                <td className="px-3 py-2.5 text-right tabular-nums">{money(p.sellPriceCents, fmt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Action = 'category' | 'min_stock' | 'status' | 'bin' | 'sell_price' | 'cost';

function BulkBar({ ids, categories, fmt, showCost, onDone }: { ids: string[]; categories: { value: string; label: string }[]; fmt: MoneyFmt; showCost: boolean; onDone: () => void }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const [action, setAction] = useState<Action>('category');
  const [preview, setPreview] = useState<{ count: number; items: { id: string; sku: string; name: string; before: Record<string, unknown>; after: Record<string, unknown> }[] } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ categoryId: '', minStock: '', status: 'INACTIVE', bin: '', storageArea: '', priceMode: 'percent', priceValue: '', reason: '' });
  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setPreview(null); };
  const risky = action === 'sell_price' || action === 'cost';

  function body(previewOnly: boolean) {
    const b: Record<string, unknown> = { ids, action, preview: previewOnly, confirm: !previewOnly && risky };
    if (action === 'category') b.categoryId = form.categoryId;
    if (action === 'min_stock') b.minStock = form.minStock;
    if (action === 'status') b.status = form.status;
    if (action === 'bin') { b.bin = form.bin; b.storageArea = form.storageArea; }
    if (risky) {
      b.priceMode = form.priceMode;
      b.reason = form.reason;
      if (form.priceMode === 'percent') b.priceValue = Math.round(Number((form.priceValue ?? '').replace(',', '.')) * 100);
      else { const c = randToCentsOrNull(form.priceValue ?? ''); b.priceValue = c ?? 0; }
    }
    return b;
  }
  const show = (v: unknown) => (typeof v === 'number' ? money(v, fmt) : v === null || v === undefined ? '—' : String(v));

  return (
    <div className="space-y-3 rounded-xl border border-brand-100 bg-brand-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{ids.length} part{ids.length === 1 ? '' : 's'} selected</p><Button type="button" variant="ghost" onClick={onDone}>Clear</Button></div>
      {error && <Alert>{error}</Alert>}
      {applied && <Alert tone="ok">{applied}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Change" htmlFor="bulk-action">
          <Select id="bulk-action" value={action} onChange={(e) => { setAction(e.target.value as Action); setPreview(null); }}>
            <option value="category">Category</option><option value="min_stock">Minimum stock</option><option value="status">Active / inactive / archive</option><option value="bin">Bin</option><option value="sell_price">Selling price</option>{showCost && <option value="cost">Cost price</option>}
          </Select>
        </Field>
        {action === 'category' && <Field label="Category" htmlFor="bulk-cat"><Select id="bulk-cat" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}><option value="">No category</option>{categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></Field>}
        {action === 'min_stock' && <Field label="Minimum stock" htmlFor="bulk-min"><Input id="bulk-min" inputMode="numeric" value={form.minStock} onChange={(e) => set('minStock', e.target.value)} /></Field>}
        {action === 'status' && <Field label="Status" htmlFor="bulk-status"><Select id="bulk-status" value={form.status} onChange={(e) => set('status', e.target.value)}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="ARCHIVED">Archived</option></Select></Field>}
        {action === 'bin' && <><Field label="Bin" htmlFor="bulk-bin"><Input id="bulk-bin" value={form.bin} onChange={(e) => set('bin', e.target.value)} /></Field><Field label="Storage area" htmlFor="bulk-area"><Input id="bulk-area" value={form.storageArea} onChange={(e) => set('storageArea', e.target.value)} /></Field></>}
        {risky && (
          <>
            <Field label="How" htmlFor="bulk-mode"><Select id="bulk-mode" value={form.priceMode} onChange={(e) => set('priceMode', e.target.value)}><option value="percent">Change by a percentage</option><option value="delta">Add or take off an amount</option><option value="set">Set to an amount</option></Select></Field>
            <Field label={form.priceMode === 'percent' ? 'Percent (e.g. 10 or -5)' : 'Amount (rand)'} htmlFor="bulk-val"><Input id="bulk-val" inputMode="decimal" value={form.priceValue} onChange={(e) => set('priceValue', e.target.value)} /></Field>
            <Field label="Reason" htmlFor="bulk-reason"><Input id="bulk-reason" value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Annual price increase" /></Field>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" loading={pending || !ready} onClick={() => { setApplied(null); void run(async () => { const r = await api<typeof preview>('/api/v1/inventory/parts/bulk', { method: 'POST', body: body(true) }); setPreview(r.data); }); }}>Preview</Button>
        {preview && <Button type="button" loading={pending} onClick={() => void run(async () => { await api('/api/v1/inventory/parts/bulk', { method: 'POST', body: body(false) }); setApplied(`Changed ${preview.count} part${preview.count === 1 ? '' : 's'}.`); setPreview(null); onDone(); router.refresh(); })}>{risky ? `Confirm and change ${preview.count}` : `Apply to ${preview.count}`}</Button>}
      </div>
      {preview && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-line bg-surface text-sm">
          <ul className="divide-y divide-line">
            {preview.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><span className="truncate">{i.sku} — {i.name}</span><span className="tabular-nums text-muted">{Object.values(i.before).map(show).join(', ')} → <strong className="text-ink">{Object.values(i.after).map(show).join(', ')}</strong></span></li>
            ))}
          </ul>
          {preview.count > preview.items.length && <p className="px-3 py-2 text-xs text-muted">…and {preview.count - preview.items.length} more.</p>}
        </div>
      )}
      <p className="text-xs text-muted">{risky ? 'Price changes are shown first and need a second click to apply. Every old price stays in the part’s price history.' : 'Changes are recorded in the audit log.'}</p>
    </div>
  );
}
