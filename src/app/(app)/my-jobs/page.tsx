import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { JobStatusBadge, PriorityBadge } from '@/components/workshop/badges';
import { listMyJobs } from '@/server/jobcards/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDateTime } from '@/lib/format';
import { TimerWidget } from '@/components/team/TimerWidget';
import { getMyDay } from '@/server/team/technicians';

export const metadata: Metadata = { title: 'My jobs' };
export const dynamic = 'force-dynamic';

const action = 'inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border px-3 text-sm font-semibold';
const secondary = `${action} border-line bg-surface hover:bg-canvas`;
const primary = `${action} border-brand-600 bg-brand-600 text-white hover:bg-brand-700`;

/** The technician's phone-first queue: only their open jobs, most urgent first, with the next actions one tap away. */
export default async function MyJobsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'job.view');
  const [jobs, day] = await Promise.all([listMyJobs(ctx), getMyDay(ctx)]);
  const timer = ctx.subscription.features.has('technician_management') && ctx.permissions.has('time.record') && ctx.subscription.canWrite;
  const time = (d: Date) => new Intl.DateTimeFormat(ctx.business.locale, { hour: '2-digit', minute: '2-digit', timeZone: ctx.business.timezone }).format(d);
  const canInspect = ctx.permissions.has('job.inspect');
  return (
    <>
      <PageHeader title="My jobs" description="Jobs assigned to you." />
      {timer && <div className="mb-4"><TimerWidget canPost={ctx.permissions.has('job.edit')} /></div>}
      {(day.bookings.length > 0 || day.off) && (
        <Card className="mb-4">
          <h2 className="mb-2 text-base font-semibold">Today</h2>
          {day.off && <p className="mb-2 text-sm text-warn">You are marked as off today ({day.off.kind.toLowerCase().replace('_', ' ')}{day.off.reason ? `: ${day.off.reason}` : ''}).</p>}
          <ul className="divide-y divide-line">{day.bookings.map((b) => <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span><strong>{time(b.startsAt)}–{time(b.endsAt)}</strong> {b.serviceLabel}</span><span className="text-muted">{[b.vehicle.registration, [b.vehicle.make, b.vehicle.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</span></li>)}</ul>
        </Card>
      )}
      {jobs.length === 0 ? (
        <EmptyState title="Nothing assigned to you">When a job is assigned to you it appears here. <Link href="/jobs" className="font-medium text-brand-700 underline">See all jobs</Link>.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li key={j.id}>
              <Card>
                <Link href={`/jobs/${j.id}`} className="block">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-bold">{j.vehicle.registration ?? j.jobNumber}</p>
                      <p className="text-sm">{[j.vehicle.make, j.vehicle.model].filter(Boolean).join(' ')}</p>
                      <p className="text-sm text-muted">{j.customer.name} · {j.jobNumber}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1"><JobStatusBadge status={j.status} /><PriorityBadge priority={j.priority} /></div>
                  </div>
                  {j.complaint && <p className="mt-2 line-clamp-3 text-sm">{j.complaint}</p>}
                  <p className="mt-1 text-xs text-muted">Opened {formatDateTime(j.openedAt, ctx.business.timezone, ctx.business.locale)}</p>
                  {day.partsByJob[j.id] && (day.partsByJob[j.id]!.reserved > 0 || day.partsByJob[j.id]!.fitted > 0 || day.partsByJob[j.id]!.waiting > 0) && <p className="mt-1 text-xs text-muted">Parts: {[day.partsByJob[j.id]!.reserved > 0 && `${day.partsByJob[j.id]!.reserved} reserved`, day.partsByJob[j.id]!.waiting > 0 && `${day.partsByJob[j.id]!.waiting} waiting`, day.partsByJob[j.id]!.fitted > 0 && `${day.partsByJob[j.id]!.fitted} fitted`].filter(Boolean).join(' · ')}</p>}
                </Link>
                <div className="mt-3 flex gap-2">
                  <Link href={`/jobs/${j.id}`} className={primary}>Open</Link>
                  {canInspect && <Link href={`/jobs/${j.id}?tab=inspection`} className={secondary}>Inspect</Link>}
                  <Link href={`/jobs/${j.id}?tab=parts`} className={secondary}>Parts</Link>
                  <Link href={`/jobs/${j.id}?tab=photos`} className={secondary}>Photos</Link>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
