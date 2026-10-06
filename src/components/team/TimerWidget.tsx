'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

interface Running { id: string; jobId: string; jobNumber: string; startedAt: string; elapsedSeconds: number }

const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * A job timer that lives on the server. The browser only asks "is a timer running?" and displays the elapsed time the server works out, so a refresh, a locked phone
 * or a lost connection loses nothing: when the page comes back (or the phone comes back online) it asks again. Start and stop carry keys, so a double tap or a retry
 * is the same request.
 */
export function TimerWidget({ jobId, jobNumber, canPost }: { jobId?: string; jobNumber?: string; canPost: boolean }) {
  const [running, setRunning] = useState<Running | null | undefined>(undefined);
  const [skew, setSkew] = useState(0);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [post, setPost] = useState(true);
  const startedKey = useRef(`k-${crypto.randomUUID()}`);

  const load = useCallback(async () => {
    try {
      const r = await api<Running | null>('/api/v1/team/time/running');
      setRunning(r.data);
      setSkew(r.data ? Date.now() - r.data.elapsedSeconds * 1000 - new Date(r.data.startedAt).getTime() : 0);
    } catch {
      setRunning((cur) => (cur === undefined ? null : cur));
    }
  }, []);

  useEffect(() => {
    void load();
    const again = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('online', again);
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('online', again); };
  }, [load]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  async function start() {
    if (!jobId) return;
    setBusy(true);
    setErr(null);
    try {
      await api('/api/v1/team/time/start', { method: 'POST', body: { jobId, idempotencyKey: startedKey.current } });
      startedKey.current = `k-${crypto.randomUUID()}`;
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not start the timer. Check your connection and try again.');
      await load();
    } finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true);
    setErr(null);
    try {
      await api('/api/v1/team/time/stop', { method: 'POST', body: { postToLabour: canPost && post } });
      setRunning(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not stop the timer. Check your connection and try again.');
      await load();
    } finally { setBusy(false); }
  }

  if (running === undefined) return null;
  const elapsed = running ? Math.max(0, Math.floor((Date.now() - skew - new Date(running.startedAt).getTime()) / 1000)) : 0;
  void tick;
  const here = !!running && running.jobId === jobId;

  return (
    <Card className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Job timer</p>
          {running ? <p className="font-mono text-3xl font-bold tabular-nums" aria-live="off">{clock(elapsed)}</p> : <p className="text-sm text-muted">No timer running.</p>}
          {running && <p className="text-xs text-muted">{here ? 'On this job' : <>On job <Link href={`/jobs/${running.jobId}`} className="font-medium text-brand-700 underline">{running.jobNumber}</Link></>} · kept on the server, so it carries on if you leave this page.</p>}
        </div>
        {running ? <Button type="button" variant="danger" className="min-w-28" loading={busy} onClick={() => void stop()}>Stop</Button> : jobId ? <Button type="button" className="min-w-28" loading={busy} onClick={() => void start()}>Start{jobNumber ? ` on ${jobNumber}` : ''}</Button> : null}
      </div>
      {running && canPost && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={post} onChange={(e) => setPost(e.target.checked)} />Add this time to the job as labour when I stop</label>}
      {err && <Alert>{err}</Alert>}
    </Card>
  );
}
