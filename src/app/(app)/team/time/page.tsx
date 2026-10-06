import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InvNavShim } from '@/components/team/InvNavShim';
import { ManualTimeForm, TimeEntryActions } from '@/components/team/TimeEntryForm';
import { Chips, Stat, qs } from '@/components/workshop/layout';
import { formatDateTime } from '@/lib/format';
import { listJobs } from '@/server/jobcards/service';
import { listTimeEntries } from '@/server/team/time';
import { listEmployees } from '@/server/team/directory';
import { requireBusiness } from '@/server/web/session';
import { Errors } from '@/lib/errors';

export const metadata: Metadata = { title: 'Time' };
export const dynamic = 'force-dynamic';

type Search = { page?: string; membershipId?: string; status?: string; from?: string; to?: string };
const hours = (m: number | null) => (m === null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
const field = 'min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10';

export default async function TimePage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  if (!can('time.view_all') && !can('time.record')) throw Errors.forbidden();
  const sp = await searchParams;
  if (!ctx.subscription.features.has('technician_management')) return <><PageHeader title="Time" /><InvNavShim ctx={ctx} active="time" /><Alert tone="warn">Time tracking is included from the Team plan. Labour can still be recorded on each job.</Alert></>;
  const everyone = can('time.view_all');
  const [r, people, jobs] = await Promise.all([
    listTimeEntries(ctx, { page: sp.page, membershipId: everyone ? sp.membershipId || undefined : undefined, status: sp.status || undefined, from: sp.from || undefined, to: sp.to || undefined, pageSize: 25 }),
    everyone ? listEmployees(ctx, { status: 'ACTIVE', pageSize: 100 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    can('job.view') ? listJobs(ctx, { status: 'open', pageSize: 50 }).then((j) => j.items).catch(() => []) : Promise.resolve([]),
  ]);
  const href = (over: Partial<Search>) => `/team/time${qs({ membershipId: sp.membershipId, status: sp.status, from: sp.from, to: sp.to }, { page: undefined, ...over })}`;
  const writable = ctx.subscription.canWrite;

  return (
    <>
      <PageHeader title="Time" description={everyone ? 'Time logged on jobs.' : 'Your time on jobs.'} actions={can('report.export') && everyone && ctx.subscription.features.has('data_export') && <LinkButton href={`/api/v1/team/export?dataset=time_entries&format=xlsx${sp.from ? `&from=${sp.from}` : ''}${sp.to ? `&to=${sp.to}` : ''}`} variant="secondary">Export</LinkButton>} />
      <InvNavShim ctx={ctx} active="time" />
      <form action="/team/time" className="mb-3 flex flex-wrap items-end gap-2">
        {everyone && <label className="grid gap-1 text-xs text-muted">Person<select name="membershipId" defaultValue={sp.membershipId ?? ''} className={field}><option value="">Everyone</option>{people.items.map((p) => <option key={p.id} value={p.id}>{p.name ?? p.email}</option>)}</select></label>}
        <label className="grid gap-1 text-xs text-muted">From<input type="date" name="from" defaultValue={sp.from} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input type="date" name="to" defaultValue={sp.to} className={field} /></label>
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply</button>
      </form>
      <div className="mb-4"><Chips items={[['All', undefined], ['Running', 'RUNNING'], ['Completed', 'COMPLETED'], ['Voided', 'VOIDED']].map(([label, status]) => ({ label: label!, href: href({ status }), active: (status ?? '') === (sp.status ?? '') }))} /></div>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3"><Stat label="Logged" value={hours(r.totals.minutes)} /><Stat label="Billable" value={hours(r.totals.billableMinutes)} /></div>
      {r.items.length === 0 ? <EmptyState title="No time entries">Start a timer on a job, or log time by hand below.</EmptyState> : (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {r.items.map((t) => (
              <li key={t.id} className="space-y-1 px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2"><span>{everyone && <strong>{t.personName} · </strong>}<Link href={`/jobs/${t.jobId}?tab=parts`} className="font-semibold text-brand-700 hover:underline">{t.jobNumber}</Link> · {hours(t.durationMinutes)}{t.status === 'RUNNING' ? ' (running)' : ''}</span><span className="flex items-center gap-1">{!t.billable && <Badge>not billable</Badge>}{t.posted && <Badge tone="ok">labour</Badge>}{t.approved && <Badge>approved</Badge>}{t.status === 'VOIDED' && <Badge tone="danger">voided</Badge>}</span></div>
                <p className="text-xs text-muted">{formatDateTime(t.startedAt, ctx.business.timezone, ctx.business.locale)}{t.notes ? ` · ${t.notes}` : ''}{t.voidReason ? ` · voided: ${t.voidReason}` : ''}{t.editCount ? ` · edited ${t.editCount}×` : ''}</p>
                {everyone && <TimeEntryActions id={t.id} status={t.status} posted={t.posted} approved={t.approved} canEdit={can('time.edit') && writable} canApprove={can('time.approve') && writable} canPost={can('time.edit') && writable} />}
              </li>
            ))}
          </ul>
          <Pagination page={r.meta.page} totalPages={r.meta.totalPages} total={r.meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
      {writable && (can('time.record') || can('time.edit')) && (
        <Card className="mt-4 max-w-2xl"><h2 className="mb-2 text-base font-semibold">Log time by hand</h2>
          <ManualTimeForm jobs={jobs.map((j) => ({ id: j.id, label: `${j.jobNumber} — ${j.vehicle.registration ?? ''}` }))} people={can('time.edit') ? people.items.map((p) => ({ id: p.id, name: p.name ?? p.email ?? '' })) : []} />
        </Card>
      )}
    </>
  );
}
