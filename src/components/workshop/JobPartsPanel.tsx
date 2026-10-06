'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';
import { InlineForm } from '@/components/forms/InlineForm';
import { PartPicker, type PickedPart } from '@/components/inventory/PartPicker';
import { money, type MoneyFmt } from '@/components/inventory/shared';
import { api, ApiError } from '@/lib/api-client';

export interface JobPartView {
  id: string;
  description: string;
  partNumber: string | null;
  quantity: number;
  status: 'REQUESTED' | 'RESERVED' | 'ORDERED' | 'FITTED' | 'RETURNED';
  costCents: number | null;
  sellPriceCents: number | null;
  inventoryItemId: string | null;
  catalogue: boolean;
  sku: string | null;
  unit: string | null;
  availableNow: number | null;
}

const STATUS_TONE = { REQUESTED: 'neutral', ORDERED: 'brand', RESERVED: 'warn', FITTED: 'ok', RETURNED: 'neutral' } as const;
const STATUS_TEXT = { REQUESTED: 'Requested', ORDERED: 'Ordered', RESERVED: 'Reserved', FITTED: 'Fitted', RETURNED: 'Returned' } as const;
const FREE_STATUS = [{ value: 'REQUESTED', label: 'Requested' }, { value: 'ORDERED', label: 'Ordered' }, { value: 'RESERVED', label: 'Reserved' }, { value: 'FITTED', label: 'Fitted' }, { value: 'RETURNED', label: 'Returned' }];

/**
 * The parts on a job. Parts from the catalogue are tied to real stock: Reserve holds them for this job (they stay on the shelf), Fitted uses them (on hand drops once),
 * Return puts them back. Parts typed in by hand are just notes on the job and never touch stock. Every button asks the server, which checks the real quantities.
 */
export function JobPartsPanel({ jobId, parts, canEdit, pricing, showCost, fmt, canUseCatalogue }: { jobId: string; parts: JobPartView[]; canEdit: boolean; pricing: boolean; showCost: boolean; fmt: MoneyFmt; canUseCatalogue: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [ack, setAck] = useState<{ id: string; message: string } | null>(null);
  const [adding, setAdding] = useState<PickedPart | null>(null);
  const [qty, setQty] = useState('1');
  const [free, setFree] = useState(false);

  async function move(p: JobPartView, status: string, extra: Record<string, unknown> = {}) {
    setBusy(`${p.id}:${status}`);
    setErr(null);
    setNote(null);
    try {
      await api(`/api/v1/jobs/${jobId}/parts/${p.id}`, { method: 'PATCH', body: { status, ...extra } });
      setAck(null);
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Something went wrong.';
      if (e instanceof ApiError && /credit note/i.test(msg) && /Confirm that the credit note covers/i.test(msg)) setAck({ id: p.id, message: msg });
      else setErr(msg);
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!adding) return;
    setBusy('add');
    setErr(null);
    setNote(null);
    try {
      const r = await api<{ status: string; unavailable?: { available: number } | null }>(`/api/v1/jobs/${jobId}/parts`, { method: 'POST', body: { inventoryItemId: adding.id, quantity: qty } });
      setNote(r.data.unavailable ? `Added as requested: only ${r.data.unavailable.available} available, so nothing was reserved. The stock team has been told.` : r.data.status === 'RESERVED' ? 'Added and reserved.' : 'Added.');
      setAdding(null);
      setQty('1');
      router.refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  const btn = (p: JobPartView, status: string, label: string, variant: 'primary' | 'secondary' | 'ghost' = 'secondary') => (
    <Button type="button" variant={variant} className="!min-h-11 flex-1 sm:flex-none" loading={busy === `${p.id}:${status}`} disabled={busy !== null} onClick={() => void move(p, status)}>{label}</Button>
  );

  return (
    <Card>
      <h2 className="mb-2 text-base font-semibold">Parts</h2>
      {err && <div className="mb-2"><Alert>{err}</Alert></div>}
      {note && <div className="mb-2"><Alert tone="ok">{note}</Alert></div>}
      {parts.length === 0 ? <p className="text-sm text-muted">No parts recorded yet.</p> : (
        <ul className="divide-y divide-line">
          {parts.map((p) => (
            <li key={p.id} className={clsx('space-y-1.5 py-2.5 text-sm', p.status === 'RETURNED' && 'opacity-60')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-medium">{p.quantity} × {p.catalogue && p.inventoryItemId ? <Link href={`/inventory/parts/${p.inventoryItemId}`} className="text-brand-700 hover:underline">{p.description}</Link> : p.description}{p.partNumber ? ` (${p.partNumber})` : ''}</span>
                <Badge tone={STATUS_TONE[p.status]}>{STATUS_TEXT[p.status]}</Badge>
              </div>
              {p.catalogue && p.availableNow !== null && ['REQUESTED', 'ORDERED'].includes(p.status) && <p className={clsx('text-xs', p.availableNow < p.quantity ? 'font-medium text-danger' : 'text-muted')}>{p.availableNow} available now{p.availableNow < p.quantity ? ' — not enough' : ''}</p>}
              {p.status === 'RESERVED' && <p className="text-xs text-muted">Held for this job. Still on the shelf until it is fitted.</p>}
              {pricing && (p.sellPriceCents != null || (showCost && p.costCents != null)) && <p className="text-xs text-muted">{p.sellPriceCents != null && <>Sell {money(p.sellPriceCents, fmt)} each</>}{showCost && p.costCents != null && <> · cost {money(p.costCents, fmt)}</>}</p>}
              {canEdit && p.catalogue && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {['REQUESTED', 'ORDERED'].includes(p.status) && <>{btn(p, 'RESERVED', 'Reserve')}{btn(p, 'FITTED', 'Fitted', 'primary')}</>}
                  {p.status === 'RESERVED' && <>{btn(p, 'FITTED', 'Mark fitted', 'primary')}{btn(p, 'RETURNED', 'Release')}</>}
                  {p.status === 'FITTED' && btn(p, 'RETURNED', 'Return to stock')}
                  {['REQUESTED', 'ORDERED', 'RESERVED'].includes(p.status) && (
                    <Button type="button" variant="ghost" className="!min-h-11" disabled={busy !== null} onClick={async () => { setBusy(`${p.id}:rm`); setErr(null); try { await api(`/api/v1/jobs/${jobId}/parts/${p.id}`, { method: 'DELETE' }); router.refresh(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong.'); } finally { setBusy(null); } }}>Remove</Button>
                  )}
                </div>
              )}
              {canEdit && !p.catalogue && (
                <InlineForm endpoint={`/api/v1/jobs/${jobId}/parts/${p.id}`} method="PATCH" submitLabel="Update" variant="secondary" resetOnSuccess={false} compact fields={[{ name: 'status', label: 'Status', type: 'select', defaultValue: p.status, options: FREE_STATUS }]} />
              )}
              {ack?.id === p.id && (
                <div className="space-y-2 rounded-lg border border-warn/30 bg-warn-bg p-3">
                  <p className="text-sm">{ack.message}</p>
                  <Button type="button" variant="primary" onClick={() => void move(p, 'RETURNED', { acknowledgeCreditNote: true })}>The credit note covers it: return to stock</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          {canUseCatalogue && (
            adding ? (
              <div className="space-y-2 rounded-xl border border-brand-100 bg-brand-50 p-3">
                <p className="text-sm font-semibold">{adding.name}</p>
                <p className="text-xs text-muted">{adding.available} available · {adding.state === 'OUT' ? 'out of stock' : adding.state === 'LOW' ? 'low stock' : 'in stock'}{pricing ? ` · ${money(adding.sellPriceCents, fmt)} each` : ''}</p>
                <div className="flex items-end gap-2">
                  <label className="grid gap-1 text-xs text-muted">Quantity<Input className="!w-24" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
                  <Button type="button" loading={busy === 'add'} onClick={() => void add()}>Add to job</Button>
                  <Button type="button" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <details open={parts.length === 0}>
                <summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Add a part from stock</summary>
                <div className="pt-1"><PartPicker allowScan onPick={setAdding} extraQuery="" /></div>
              </details>
            )
          )}
          <div>
            <button type="button" className="min-h-11 text-sm font-medium text-brand-700" onClick={() => setFree((v) => !v)}>{free ? 'Hide' : 'Add a part that is not in stock records'}</button>
            {free && (
              <InlineForm endpoint={`/api/v1/jobs/${jobId}/parts`} submitLabel="Add part" fields={[
                { name: 'description', label: 'Part', required: true, span: 'full' }, { name: 'partNumber', label: 'Part number' }, { name: 'quantity', label: 'Quantity', type: 'number', defaultValue: '1' },
                { name: 'status', label: 'Status', type: 'select', defaultValue: 'REQUESTED', options: FREE_STATUS },
                ...(pricing ? [{ name: 'costCents', label: 'Cost each (rand)', inputMode: 'decimal' as const, parse: 'cents' as const }, { name: 'sellPriceCents', label: 'Selling price each (rand)', inputMode: 'decimal' as const, parse: 'cents' as const }] : []),
              ]} />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
