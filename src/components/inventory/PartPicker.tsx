'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { api } from '@/lib/api-client';
import { BarcodeScanner, cameraScanningSupported } from './BarcodeScanner';
import { StockBadge } from './shared';

export interface PickedPart {
  id: string;
  sku: string;
  partNumber: string | null;
  name: string;
  brand: string | null;
  unit: string;
  costCents: number | null;
  sellPriceCents: number | null;
  taxTreatment: string;
  onHand: number;
  reserved: number;
  available: number;
  state: string;
  status: string;
  barcode: string | null;
}

/**
 * Search the stock catalogue as you type (the server searches name, SKU, part number, barcode, brand and supplier part number, a page at a time) or scan a
 * barcode. A scanner that types into the box works as it is. Availability shown is what the server says is available to this person now.
 */
export function PartPicker({
  onPick, extraQuery = '', placeholder = 'Search by name, SKU, part number or barcode', allowScan = false, autoFocus = false,
}: {
  onPick: (p: PickedPart) => void;
  extraQuery?: string;
  placeholder?: string;
  allowScan?: boolean;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PickedPart[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);
  const canScan = allowScan && cameraScanningSupported();

  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<PickedPart[]>(`/api/v1/inventory/parts?pageSize=8&status=ACTIVE&sort=name${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${extraQuery}`);
        if (mine === seq.current) setItems(r.data);
      } catch {
        if (mine === seq.current) setItems([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, extraQuery]);

  const onCode = useCallback(
    async (code: string) => {
      setScanning(false);
      setNote(null);
      try {
        const r = await api<{ items: PickedPart[] }>(`/api/v1/inventory/parts/lookup?code=${encodeURIComponent(code)}`);
        if (r.data.items.length === 1) onPick(r.data.items[0]!);
        else if (r.data.items.length > 1) { setItems(r.data.items); setNote(`${r.data.items.length} parts share that code. Choose one.`); }
        else { setQ(code); setNote(`No part has the code ${code}.`); }
      } catch {
        setQ(code);
      }
    },
    [onPick],
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoComplete="off" autoFocus={autoFocus} inputMode="search" aria-label="Search parts"
          onKeyDown={(e) => {
            // a keyboard-wedge scanner types the code and presses Enter: an exact code goes straight to the part
            if (e.key === 'Enter') { e.preventDefault(); if (q.trim()) void onCode(q.trim()); }
          }}
        />
        {canScan && <Button type="button" variant="secondary" onClick={() => setScanning((s) => !s)} aria-pressed={scanning}>Scan</Button>}
      </div>
      {scanning && <BarcodeScanner onCode={(c) => void onCode(c)} onClose={() => setScanning(false)} />}
      {note && <p className="text-xs text-muted">{note}</p>}
      <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface" aria-busy={loading}>
        {items.length === 0 && !loading && <li className="px-3 py-3 text-sm text-muted">{q ? 'No parts match.' : 'No parts yet.'}</li>}
        {items.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p)} className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-canvas">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{p.name}</span>
                <span className="block truncate text-xs text-muted">{[p.sku, p.partNumber, p.brand].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className={clsx('block text-sm font-bold tabular-nums', p.available <= 0 && 'text-danger')}>{p.available} avail.</span>
                <StockBadge state={p.state} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
