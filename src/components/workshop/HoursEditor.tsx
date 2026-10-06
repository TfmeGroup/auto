'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { minutesToHhmm } from '@/lib/tz';

interface Interval { weekday: number; startMinute: number; endMinute: number }
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY = [1, 2, 3, 4, 5, 6, 0]; // Monday first, matching the calendar

/**
 * Weekly hours: each day is closed or has one or two spans (two lets you leave a gap for lunch). Used for the workshop's
 * opening hours and for an individual technician's working hours. Saved as a whole; the server validates every span.
 */
export function HoursEditor({ endpoint, initial, emptyMeans }: { endpoint: string; initial: Interval[]; emptyMeans: string }) {
  const router = useRouter();
  const [rows, setRows] = useState(() =>
    WEEKDAY.map((wd) => {
      const day = initial.filter((i) => i.weekday === wd).sort((a, b) => a.startMinute - b.startMinute);
      return {
        wd,
        open: day.length > 0,
        a: [day[0] ? minutesToHhmm(day[0].startMinute) : '08:00', day[0] ? minutesToHhmm(day[0].endMinute) : '17:00'] as [string, string],
        second: day.length > 1,
        b: [day[1] ? minutesToHhmm(day[1].startMinute) : '13:00', day[1] ? minutesToHhmm(day[1].endMinute) : '17:00'] as [string, string],
      };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    const intervals = rows.flatMap((r) => (!r.open ? [] : [{ weekday: r.wd, start: r.a[0], end: r.a[1] }, ...(r.second ? [{ weekday: r.wd, start: r.b[0], end: r.b[1] }] : [])]));
    try {
      await api(endpoint, { method: 'PUT', body: { intervals } });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? (Object.values(e.fields)[0] ?? e.message) : 'We could not reach the server.');
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {rows.map((r, i) => (
          <li key={r.wd} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <label className="flex min-h-11 w-32 items-center gap-2 text-sm font-medium"><input type="checkbox" className="size-5" checked={r.open} onChange={(e) => update(i, { open: e.target.checked })} />{DAYS[i]}</label>
            {r.open ? (
              <>
                <Input aria-label={`${DAYS[i]} opens`} type="time" value={r.a[0]} onChange={(e) => update(i, { a: [e.target.value, r.a[1]] })} className="w-28" />
                <span aria-hidden>–</span>
                <Input aria-label={`${DAYS[i]} closes`} type="time" value={r.a[1]} onChange={(e) => update(i, { a: [r.a[0], e.target.value] })} className="w-28" />
                {r.second ? (
                  <>
                    <span className="text-muted">and</span>
                    <Input aria-label={`${DAYS[i]} second span opens`} type="time" value={r.b[0]} onChange={(e) => update(i, { b: [e.target.value, r.b[1]] })} className="w-28" />
                    <span aria-hidden>–</span>
                    <Input aria-label={`${DAYS[i]} second span closes`} type="time" value={r.b[1]} onChange={(e) => update(i, { b: [r.b[0], e.target.value] })} className="w-28" />
                    <button type="button" className="min-h-11 px-2 text-sm text-muted underline" onClick={() => update(i, { second: false })}>Remove break</button>
                  </>
                ) : (
                  <button type="button" className="min-h-11 px-2 text-sm text-brand-700 underline" onClick={() => update(i, { second: true, a: [r.a[0], '12:00'] })}>Add a break</button>
                )}
              </>
            ) : <span className="text-sm text-muted">Closed</span>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{emptyMeans}</p>
      <div className="flex items-center gap-3"><Button type="button" variant="secondary" loading={busy} onClick={save}>Save hours</Button>{saved && <span role="status" className="text-sm font-medium text-ok">Saved</span>}</div>
    </div>
  );
}
