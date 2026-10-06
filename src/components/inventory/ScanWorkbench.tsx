'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { PartPicker, type PickedPart } from './PartPicker';
import { StockBadge, StockNumbers, money, type MoneyFmt } from './shared';
import { AdjustStockForm } from './StockForms';

interface StockView { locations: { locationId: string; locationName: string; onHand: number; reserved: number; available: number; bin: string | null; storageArea: string | null }[]; onHand: number; reserved: number; available: number; state: string }
interface JobHit { id: string; jobNumber: string; status: string; vehicle?: { registration?: string | null; make?: string | null; model?: string | null }; customer?: { name: string } }

/**
 * The phone workflow: find a part (type, scan with a hardware scanner, or use the camera where the browser can), see how many there really are and where,
 * then do the thing: put it on a job, or correct the count. Everything shown and every change comes from the server.
 */
export function ScanWorkbench({ fmt, canAdjust, canAddToJob, showCost, locations, barcode }: { fmt: MoneyFmt; barcode: boolean; canAdjust: boolean; canAddToJob: boolean; showCost: boolean; locations: { id: string; name: string }[] }) {
  const [part, setPart] = useState<PickedPart | null>(null);
  const [stock, setStock] = useState<StockView | null>(null);
  const [mode, setMode] = useState<'view' | 'job' | 'adjust'>('view');

  const load = useCallback(async (id: string) => {
    try { setStock((await api<StockView>(`/api/v1/inventory/parts/${id}/stock`)).data); } catch { setStock(null); }
  }, []);
  useEffect(() => { if (part) void load(part.id); }, [part, load]);

  if (!part) {
    return <Card><PartPicker allowScan={barcode} autoFocus onPick={(p) => { setPart(p); setMode('view'); }} placeholder="Scan or type a barcode, SKU, part number or name" /></Card>;
  }
  return (
    <div className="space-y-3">
      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0"><p className="text-lg font-bold leading-tight">{part.name}</p><p className="truncate text-sm text-muted">{[part.sku, part.partNumber, part.brand].filter(Boolean).join(' · ')}</p></div>
          <StockBadge state={stock?.state ?? part.state} />
        </div>
        <StockNumbers onHand={stock?.onHand ?? part.onHand} reserved={stock?.reserved ?? part.reserved} available={stock?.available ?? part.available} unit={part.unit} />
        {stock && stock.locations.length > 1 && (
          <ul className="space-y-1 text-sm">{stock.locations.map((l) => <li key={l.locationId} className="flex justify-between gap-2"><span>{l.locationName}{l.bin ? <span className="text-muted"> · {l.bin}</span> : null}</span><span className="tabular-nums">{l.available} available ({l.onHand} on hand)</span></li>)}</ul>
        )}
        {stock && stock.locations.length === 1 && (stock.locations[0]!.bin || stock.locations[0]!.storageArea) && <p className="text-sm text-muted">Kept at {[stock.locations[0]!.storageArea, stock.locations[0]!.bin].filter(Boolean).join(' → ')}</p>}
        <p className="text-sm">Price {money(part.sellPriceCents, fmt)}{showCost ? ` · cost ${money(part.costCents, fmt)}` : ''}</p>
        <div className="flex flex-wrap gap-2">
          {canAddToJob && <Button type="button" variant={mode === 'job' ? 'primary' : 'secondary'} onClick={() => setMode(mode === 'job' ? 'view' : 'job')}>Add to a job</Button>}
          {canAdjust && <Button type="button" variant={mode === 'adjust' ? 'primary' : 'secondary'} onClick={() => setMode(mode === 'adjust' ? 'view' : 'adjust')}>Adjust stock</Button>}
          <Link href={`/inventory/parts/${part.id}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10">Open part</Link>
          <Button type="button" variant="ghost" onClick={() => { setPart(null); setStock(null); }}>Scan another</Button>
        </div>
      </Card>
      {mode === 'job' && <AddToJob part={part} onDone={() => { void load(part.id); setMode('view'); }} />}
      {mode === 'adjust' && <Card><AdjustStockForm partId={part.id} locations={locations} unit={part.unit} onDone={() => void load(part.id)} /></Card>}
    </div>
  );
}

function AddToJob({ part, onDone }: { part: PickedPart; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [jobs, setJobs] = useState<JobHit[]>([]);
  const [qty, setQty] = useState('1');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const r = await api<JobHit[]>(`/api/v1/jobs?status=open&pageSize=6${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : '&mine=true'}`);
        setJobs(r.data);
      } catch { setJobs([]); }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  async function add(job: JobHit) {
    setBusy(job.id);
    setMsg(null);
    try {
      const r = await api<{ status: string; unavailable?: { available: number } | null }>(`/api/v1/jobs/${job.id}/parts`, { method: 'POST', body: { inventoryItemId: part.id, quantity: qty } });
      setMsg(r.data.unavailable ? { tone: 'warn', text: `Added to ${job.jobNumber} as requested: only ${r.data.unavailable.available} available, so nothing was reserved.` } : { tone: 'ok', text: `Added to ${job.jobNumber} (${r.data.status.toLowerCase()}).` });
      onDone();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Could not add the part.' });
    } finally { setBusy(null); }
  }

  return (
    <Card className="space-y-3">
      <h2 className="text-base font-semibold">Which job?</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="sm:col-span-2"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Job number, registration or customer (blank = my jobs)" aria-label="Find a job" /></div>
        <div><Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" aria-label="Quantity" /></div>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {jobs.length === 0 ? <p className="text-sm text-muted">No open jobs found.</p> : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 text-sm"><strong>{j.jobNumber}</strong> <span className="text-muted">{[j.vehicle?.registration, j.customer?.name].filter(Boolean).join(' · ')}</span></span>
              <Button type="button" loading={busy === j.id} onClick={() => void add(j)}>Add {qty || 1}</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
