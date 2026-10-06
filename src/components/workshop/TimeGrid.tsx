'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { minutesToHhmm } from '@/lib/tz';

export interface CalBooking {
  id: string;
  bookingNumber: string;
  day: string; // business-local YYYY-MM-DD
  startMin: number;
  endMin: number;
  status: string;
  customer: string;
  vehicle: string;
  service: string;
  technician: string | null;
  bay: string | null;
  timeLabel: string;
  canMove: boolean;
}
export interface CalDay { iso: string; label: string; closed?: boolean }

const TONE: Record<string, string> = {
  REQUESTED: 'border-warn bg-warn-bg text-warn',
  CONFIRMED: 'border-brand-500 bg-brand-50 text-brand-700',
  REMINDER_SENT: 'border-brand-500 bg-brand-50 text-brand-700',
  RESCHEDULED: 'border-warn bg-warn-bg text-warn',
  CHECKED_IN: 'border-ok bg-ok-bg text-ok',
  COMPLETED: 'border-ok bg-ok-bg text-ok',
  NO_SHOW: 'border-danger bg-danger-bg text-danger',
  CANCELLED: 'border-line bg-canvas text-muted line-through',
};
const STATUS_TEXT: Record<string, string> = { REQUESTED: 'Requested', CONFIRMED: 'Confirmed', REMINDER_SENT: 'Reminder sent', RESCHEDULED: 'Rescheduled', CHECKED_IN: 'Checked in', COMPLETED: 'Completed', NO_SHOW: 'No-show', CANCELLED: 'Cancelled' };

const PX_PER_HOUR = 56;
const SNAP = 15;

/** Lay out overlapping bookings of one day side by side. */
function lanes(items: CalBooking[]): Map<string, { lane: number; of: number }> {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out = new Map<string, { lane: number; of: number }>();
  let cluster: CalBooking[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    const assigned = new Map<string, number>();
    for (const b of cluster) {
      let lane = ends.findIndex((e) => e <= b.startMin);
      if (lane === -1) { lane = ends.length; ends.push(b.endMin); } else ends[lane] = b.endMin;
      assigned.set(b.id, lane);
    }
    for (const b of cluster) out.set(b.id, { lane: assigned.get(b.id)!, of: ends.length });
    cluster = [];
  };
  for (const b of sorted) {
    if (cluster.length && b.startMin >= clusterEnd) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.endMin);
  }
  if (cluster.length) flush();
  return out;
}

/**
 * Day and week calendar. On a desktop, drag a booking to another time or day to reschedule it: nothing is saved until
 * you confirm, and the server re-checks availability, capacity and your permission, so a conflicting move is refused
 * with the reason. On a phone the same data is shown as an agenda list (dragging is not offered).
 */
export function TimeGrid({ days, bookings, startHour = 7, endHour = 19, canReschedule }: { days: CalDay[]; bookings: CalBooking[]; startHour?: number; endHour?: number; canReschedule: boolean }) {
  const router = useRouter();
  const [drag, setDrag] = useState<CalBooking | null>(null);
  const [pending, setPending] = useState<{ b: CalBooking; day: string; minute: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hours = useMemo(() => Array.from({ length: endHour - startHour }, (_, i) => startHour + i), [startHour, endHour]);
  const height = (endHour - startHour) * PX_PER_HOUR;
  const byDay = useMemo(() => {
    const m = new Map<string, CalBooking[]>();
    for (const b of bookings) m.set(b.day, [...(m.get(b.day) ?? []), b]);
    return m;
  }, [bookings]);

  function onDrop(e: React.DragEvent<HTMLDivElement>, day: string) {
    e.preventDefault();
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = ((e.clientY - rect.top) / PX_PER_HOUR) * 60 + startHour * 60;
    const minute = Math.max(0, Math.min(23 * 60 + 45, Math.round(raw / SNAP) * SNAP));
    setError(null);
    if (day === drag.day && minute === drag.startMin) { setDrag(null); return; }
    setPending({ b: drag, day, minute });
    setDrag(null);
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/v1/bookings/${pending.b.id}/reschedule`, { body: { date: pending.day, time: minutesToHhmm(pending.minute) } });
      setPending(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'We could not reach the server. Nothing was changed.');
    } finally { setBusy(false); }
  }

  return (
    <div>
      {pending && (
        <div role="alertdialog" aria-label="Confirm reschedule" className="mb-3 space-y-2 rounded-lg border border-brand-500 bg-brand-50 px-3 py-2.5">
          <p className="text-sm">Move <strong>{pending.b.bookingNumber}</strong> ({pending.b.customer}) to <strong>{days.find((d) => d.iso === pending.day)?.label ?? pending.day} at {minutesToHhmm(pending.minute)}</strong>?</p>
          <div className="flex gap-2">
            <Button type="button" loading={busy} onClick={confirm}>Move booking</Button>
            <Button type="button" variant="secondary" onClick={() => { setPending(null); setError(null); }}>Keep as it was</Button>
          </div>
        </div>
      )}
      {error && <div className="mb-3"><Alert tone="warn">{error}</Alert></div>}

      {/* Desktop: time grid */}
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
        <div className="grid min-w-[44rem]" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="border-b border-line" />
          {days.map((d) => (
            <div key={d.iso} className={clsx('border-b border-l border-line px-2 py-2 text-center text-xs font-semibold', d.closed && 'bg-canvas text-muted')}>{d.label}{d.closed ? ' · closed' : ''}</div>
          ))}
          <div className="relative" style={{ height }}>
            {hours.map((h, i) => <span key={h} className="absolute right-1 -translate-y-1/2 text-[11px] text-muted" style={{ top: i * PX_PER_HOUR }}>{i === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</span>)}
          </div>
          {days.map((d) => {
            const items = byDay.get(d.iso) ?? [];
            const layout = lanes(items);
            return (
              <div
                key={d.iso}
                data-day={d.iso}
                className={clsx('relative border-l border-line', d.closed && 'bg-canvas/60')}
                style={{ height, backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${PX_PER_HOUR - 1}px, var(--color-line, #e5e7eb) ${PX_PER_HOUR - 1}px, var(--color-line, #e5e7eb) ${PX_PER_HOUR}px)` }}
                onDragOver={(e) => { if (drag) e.preventDefault(); }}
                onDrop={(e) => onDrop(e, d.iso)}
              >
                {items.map((b) => {
                  const top = ((Math.max(b.startMin, startHour * 60) - startHour * 60) / 60) * PX_PER_HOUR;
                  const h = Math.max(22, ((Math.min(b.endMin, endHour * 60) - Math.max(b.startMin, startHour * 60)) / 60) * PX_PER_HOUR - 2);
                  const { lane, of } = layout.get(b.id) ?? { lane: 0, of: 1 };
                  const draggable = canReschedule && b.canMove;
                  return (
                    <Link
                      key={b.id}
                      href={`/bookings/${b.id}`}
                      draggable={draggable}
                      onDragStart={(e) => { if (!draggable) return; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.id); setDrag(b); }}
                      onDragEnd={() => setDrag(null)}
                      title={draggable ? 'Drag to reschedule' : undefined}
                      className={clsx('absolute overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-[11px] leading-tight shadow-sm hover:z-10 hover:shadow-md', TONE[b.status] ?? TONE.CONFIRMED, draggable && 'cursor-grab active:cursor-grabbing')}
                      style={{ top, height: h, left: `calc(${(lane / of) * 100}% + 2px)`, width: `calc(${100 / of}% - 4px)` }}
                    >
                      <span className="block truncate font-semibold">{b.timeLabel} {b.customer}</span>
                      <span className="block truncate">{b.vehicle}</span>
                      {h > 48 && <span className="block truncate opacity-80">{b.service}{b.technician ? ` · ${b.technician}` : ''}</span>}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Phones: agenda */}
      <div className="space-y-4 md:hidden">
        {days.every((d) => !(byDay.get(d.iso)?.length)) && <p className="rounded-xl border border-dashed border-line bg-surface px-4 py-8 text-center text-sm text-muted">No bookings in this period.</p>}
        {days.map((d) => {
          const items = [...(byDay.get(d.iso) ?? [])].sort((a, b) => a.startMin - b.startMin);
          if (items.length === 0) return null;
          return (
            <section key={d.iso} aria-label={d.label}>
              <h3 className="mb-1.5 text-sm font-semibold">{d.label}</h3>
              <ul className="space-y-2">
                {items.map((b) => (
                  <li key={b.id}>
                    <Link href={`/bookings/${b.id}`} className={clsx('block rounded-lg border-l-4 bg-surface px-3 py-2.5 shadow-sm', TONE[b.status])}>
                      <p className="flex items-baseline justify-between gap-2 text-sm font-semibold"><span>{b.timeLabel}</span><span className="text-xs font-medium">{STATUS_TEXT[b.status] ?? b.status}</span></p>
                      <p className="text-sm">{b.customer} · {b.vehicle}</p>
                      <p className="text-xs opacity-80">{[b.service, b.technician, b.bay].filter(Boolean).join(' · ')}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
