'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function RequestExport({ datasets, disabledReason }: { datasets: { key: string; label: string }[]; disabledReason: string | null }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const [chosen, setChosen] = useState<Set<string>>(new Set(datasets.map((d) => d.key)));
  if (disabledReason) return <Alert tone="warn">{disabledReason}</Alert>;
  return (
    <div className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">Include</legend>
        {datasets.map((d) => (
          <label key={d.key} className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" className="size-5 rounded border-line" checked={chosen.has(d.key)} onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(d.key); else n.delete(d.key); return n; })} />
            {d.label}
          </label>
        ))}
      </fieldset>
      {error && <Alert>{error}</Alert>}
      <Button loading={pending || !ready} disabled={chosen.size === 0} onClick={() => void run(async () => { await api('/api/v1/exports', { body: { datasets: [...chosen] } }); router.refresh(); })}>Request export</Button>
    </div>
  );
}

/** Refreshes the page every few seconds while an export is still being generated. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
