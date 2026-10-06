import type { Metadata } from 'next';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { Chips, qs } from '@/components/workshop/layout';
import { JobList } from '@/components/workshop/Lists';
import { listJobs } from '@/server/jobcards/service';
import { JOB_STATUSES, type JobStatus } from '@/server/jobcards/transitions';
import { getJobLabels } from '@/server/settings/config-service';
import { getWorkshopLookups } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Jobs' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; technicianId?: string; priority?: string; from?: string; to?: string; serviceTypeId?: string; locationId?: string; mine?: string; sort?: string };

const selectCls = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';

export default async function JobsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'job.view');
  const JOB_STATUS_LABEL = (await getJobLabels(ctx)).status as Record<JobStatus, string>;
  const sp = await searchParams;
  const status = sp.status === 'open' || sp.status === 'closed' || (JOB_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status : 'open';
  const priority = ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(sp.priority ?? '') ? sp.priority : undefined;
  const mine = sp.mine === '1';
  const sort = sp.sort === 'priority' ? 'priority' : undefined;
  const lookups = await getWorkshopLookups(ctx);
  const query = { q: sp.q, page: sp.page, status, technicianId: sp.technicianId, priority, from: sp.from, to: sp.to, serviceTypeId: sp.serviceTypeId, locationId: sp.locationId, mine: mine ? 'true' : undefined, sort: sort ?? 'openedAt', dir: 'desc', pageSize: 25 };
  const { items, meta } = await listJobs(ctx, query);

  const base = { q: sp.q, status: status === 'open' ? undefined : status, technicianId: sp.technicianId, priority, from: sp.from, to: sp.to, serviceTypeId: sp.serviceTypeId, locationId: sp.locationId, mine: mine ? '1' : undefined, sort };
  const href = (over: Record<string, string | undefined>) => `/jobs${qs(base, { page: undefined, ...over })}`;
  const filtered = !!(sp.q || sp.technicianId || priority || sp.from || sp.to || sp.serviceTypeId || sp.locationId || mine || (status && status !== 'open'));
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);

  return (
    <>
      <PageHeader title="Jobs" description="Every job card, from check-in to collection." actions={<>{can('job.inspect') && <LinkButton href="/my-jobs" variant="secondary">My jobs</LinkButton>}{can('job.create') && <LinkButton href="/jobs/new">New job</LinkButton>}</>} />

      <form action="/jobs" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Job number, customer, registration, VIN or technician" aria-label="Search jobs" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 md:min-h-10 lg:col-span-2" />
        <select name="technicianId" defaultValue={sp.technicianId ?? ''} aria-label="Technician" className={selectCls}><option value="">All technicians</option>{lookups.technicians.map((t) => <option key={t.membershipId} value={t.membershipId}>{t.name}</option>)}</select>
        <select name="serviceTypeId" defaultValue={sp.serviceTypeId ?? ''} aria-label="Service type" className={selectCls}><option value="">All services</option>{lookups.serviceTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {lookups.locations.length > 1 && <select name="locationId" defaultValue={sp.locationId ?? ''} aria-label="Location" className={selectCls}><option value="">All locations</option>{lookups.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
        <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={selectCls} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={selectCls} /></label>
        {status && status !== 'open' && <input type="hidden" name="status" value={status} />}
        {priority && <input type="hidden" name="priority" value={priority} />}
        {mine && <input type="hidden" name="mine" value="1" />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply filters</button>
      </form>
      <div className="mb-4 space-y-2">
        <Chips items={[
          { label: 'Open', href: href({ status: undefined }), active: status === 'open' },
          ...JOB_STATUSES.map((s) => ({ label: JOB_STATUS_LABEL[s], href: href({ status: s }), active: status === s })),
          { label: 'All closed', href: href({ status: 'closed' }), active: status === 'closed' },
        ]} />
        <Chips items={[
          { label: 'Any priority', href: href({ priority: undefined }), active: !priority },
          ...(['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const).map((p) => ({ label: p.charAt(0) + p.slice(1).toLowerCase(), href: href({ priority: p }), active: priority === p })),
          { label: 'Assigned to me', href: href({ mine: mine ? undefined : '1' }), active: mine },
          { label: 'Most urgent first', href: href({ sort: sort ? undefined : 'priority' }), active: !!sort },
        ]} />
      </div>

      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No jobs match' : 'No active jobs'} action={!filtered && can('job.create') ? <LinkButton href="/jobs/new">Create a job</LinkButton> : filtered ? <LinkButton href="/jobs" variant="secondary">Clear filters</LinkButton> : undefined}>
          {filtered ? 'Try different words or clear the filters.' : 'Open a job when a vehicle arrives, or check in a booking.'}
        </EmptyState>
      ) : (
        <>
          <JobList items={items as never} fmt={{ tz: ctx.business.timezone, locale: ctx.business.locale }} />
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}
