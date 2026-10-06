import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { BookingStatusBadge } from '@/components/workshop/badges';
import { getDashboard } from '@/server/dashboard/service';
import { JOB_STATUSES, type JobStatus } from '@/server/jobcards/transitions';
import { getDashboardPrefs, getJobLabels } from '@/server/settings/config-service';
import { getAlerts } from '@/server/admin/alerts';
import { requireBusiness } from '@/server/web/session';
import { formatDateTime } from '@/lib/format';
import { Kpi, money } from '@/components/finance/shared';
import { getFinanceDashboard } from '@/server/finance/reports';
import { getInventorySnapshot } from '@/server/inventory/reports';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

function Stat({ label, value, href, tone }: { label: string; value: number | null; href?: string; tone?: 'warn' | 'ok' }) {
  if (value === null) return null;
  const inner = (
    <Card className={`h-full transition-colors hover:border-brand-500 ${tone === 'warn' && value > 0 ? 'border-warn/40' : ''}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums">{value}</p>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default async function DashboardPage() {
  const ctx = await requireBusiness();
  const d = await getDashboard(ctx);
  const JOB_STATUS_LABEL = (await getJobLabels(ctx)).status as Record<JobStatus, string>;
  const hide = await getDashboardPrefs(ctx);
  const alerts = (await getAlerts(ctx).catch(() => [])).filter((a) => a.severity !== 'info').slice(0, 3);
  const s = ctx.subscription;
  const o = d.ops;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const fmt = (x: Date) => formatDateTime(x, ctx.business.timezone, ctx.business.locale);
  const mf = { currency: ctx.business.currency, locale: ctx.business.locale };
  // Money figures come straight from the invoice and payment records (never stored as totals).
  const fin = can('finance.view_reports') ? await getFinanceDashboard(ctx, {}).catch(() => null) : null;
  const stockSnap = await getInventorySnapshot(ctx).catch(() => null);
  const quick = [
    { label: 'New quote', href: '/quotes/new', show: can('quote.create') },
    { label: 'Quotes to send', href: '/quotes?status=DRAFT', show: can('quote.send') },
    { label: 'New invoice', href: '/invoices/new', show: can('invoice.create') },
    { label: 'Record payment', href: '/payments/new', show: can('payment.create') },
    { label: 'Who owes', href: can('finance.view_reports') ? '/finance?tab=receivables' : '/invoices?payment=unpaid', show: can('invoice.view') },
    { label: 'Find customer', href: '/customers', show: can('customer.view') },
    { label: 'Find vehicle', href: '/vehicles', show: can('vehicle.view') },
  ].filter((q) => q.show);

  return (
    <>
      <PageHeader
        title={`Welcome, ${ctx.user.name.split(' ')[0]}`}
        description={`${ctx.business.name} · ${ctx.membership.roleName}`}
        actions={<>{can('job.create') && <LinkButton href="/jobs/new">New job</LinkButton>}{can('booking.create') && <LinkButton href="/bookings/new" variant="secondary">New booking</LinkButton>}</>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="My jobs" value={can('job.inspect') ? o.mine : null} href="/my-jobs" />
        <Stat label="Active jobs" value={o.activeJobs} href="/jobs" />
        <Stat label="Awaiting approval" value={o.awaitingApproval} href="/jobs?status=AWAITING_APPROVAL" tone="warn" />
        <Stat label="Ready for collection" value={o.readyForCollection} href="/jobs?status=READY_FOR_COLLECTION" tone="ok" />
        <Stat label="Awaiting parts" value={o.awaitingParts} href="/jobs?status=AWAITING_PARTS" />
        <Stat label="Unassigned jobs" value={can('job.assign') ? o.unassigned : null} href="/jobs" tone="warn" />
        <Stat label="Today’s bookings" value={o.todayBookings} href="/bookings?view=day" />
        <Stat label="Vehicles" value={d.vehicles} href="/vehicles" />
        <Stat label="Active customers" value={d.customers} href="/customers" />
        <Stat label="Team members" value={d.members} href="/team" />
        <Stat label="Documents & photos" value={d.files} />
        <Card className="h-full">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Plan</p>
          <p className="mt-1 text-lg font-bold">{s.planName}</p>
          <div className="mt-1">
            <Badge tone={s.status === 'ACTIVE' || s.status === 'TRIALING' ? 'ok' : s.status === 'EXPIRED' ? 'danger' : 'warn'}>
              {s.status === 'TRIALING' ? 'Free trial' : s.status.replace('_', ' ').toLowerCase()}
            </Badge>
          </div>
        </Card>
      </div>

      {alerts.length > 0 && (
        <section aria-label="Needs attention" className="mt-4">
          <ul className="grid gap-2 sm:grid-cols-3">
            {alerts.map((a) => (
              <li key={a.key}><Link href={a.href} className="block rounded-xl border border-warn/30 bg-warn-bg p-3 text-sm hover:border-warn"><span className="font-semibold">{a.severity === 'danger' ? 'Urgent: ' : 'Needs attention: '}{a.title}</span><span className="mt-0.5 block text-xs text-muted">{a.detail}</span></Link></li>
            ))}
          </ul>
          {ctx.permissions.has('admin.view') && <p className="mt-1 text-right text-xs"><Link href="/admin" className="font-medium text-brand-600 hover:underline">All alerts</Link></p>}
        </section>
      )}

      {fin && !hide.has('revenue') && (
        <section aria-label="Money" className="mt-4 space-y-2">
          <div className="flex items-center justify-between"><h2 className="text-base font-semibold">Money</h2><Link href="/finance" className="text-sm font-medium text-brand-600 hover:underline">Finance</Link></div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Revenue today" value={money(fin.revenue.todayCents, mf)} hint={`Month so far ${money(fin.revenue.monthCents, mf)}`} />
            <Kpi label="Received today" value={money(fin.received.todayCents, mf)} tone="ok" />
            <Kpi label="Outstanding" value={money(fin.receivables.outstandingCents, mf)} hint={`${fin.receivables.openInvoices} open invoice${fin.receivables.openInvoices === 1 ? '' : 's'}`} />
            <Kpi label="Overdue" value={money(fin.receivables.overdueCents, mf)} tone={fin.receivables.overdueCents > 0 ? 'danger' : undefined} hint={`${fin.quotes.pendingCount} quote${fin.quotes.pendingCount === 1 ? '' : 's'} awaiting approval`} />
          </div>
        </section>
      )}
      {stockSnap && !hide.has('stock') && (
        <section aria-label="Stock" className="mt-4 space-y-2">
          <div className="flex items-center justify-between"><h2 className="text-base font-semibold">Stock</h2><Link href="/inventory" className="text-sm font-medium text-brand-600 hover:underline">Open stock</Link></div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Low stock" value={stockSnap.lowStock} tone={stockSnap.lowStock > 0 ? 'warn' : undefined} />
            <Kpi label="Out of stock" value={stockSnap.outOfStock} tone={stockSnap.outOfStock > 0 ? 'danger' : undefined} />
            {stockSnap.openOrders !== null && <Kpi label="Open purchase orders" value={stockSnap.openOrders} hint={stockSnap.lateOrders ? `${stockSnap.lateOrders} late` : undefined} tone={stockSnap.lateOrders ? 'warn' : undefined} />}
          </div>
        </section>
      )}
      {quick.length > 0 && (
        <section aria-label="Quick money actions" className="mt-4">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {quick.map((q) => <li key={q.label}><Link href={q.href} className="flex min-h-12 items-center justify-center rounded-xl border border-line bg-surface px-3 text-center text-sm font-semibold hover:border-brand-500">{q.label}</Link></li>)}
          </ul>
        </section>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {o.todayList && !hide.has('bookings') && (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Today’s bookings</h2>
              <Link href="/bookings?view=day" className="text-sm font-medium text-brand-600 hover:underline">Open calendar</Link>
            </div>
            {o.todayList.length === 0 ? (
              <p className="text-sm text-muted">No bookings today.{can('booking.create') && <> <Link href="/bookings/new" className="font-medium text-brand-700 underline">Create one</Link>.</>}</p>
            ) : (
              <ul className="divide-y divide-line">
                {o.todayList.map((b) => (
                  <li key={b.id} className="py-2.5">
                    <Link href={`/bookings/${b.id}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span><span className="font-semibold">{fmt(b.startsAt).split(', ').pop()}</span> · {b.customer} · {b.vehicle}<span className="block text-xs text-muted">{[b.serviceLabel, b.technician].filter(Boolean).join(' · ')}</span></span>
                      <BookingStatusBadge status={b.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {o.jobCounts && !hide.has('jobs') && (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Jobs by stage</h2>
              <Link href="/jobs" className="text-sm font-medium text-brand-600 hover:underline">All jobs</Link>
            </div>
            {Object.keys(o.jobCounts).length === 0 ? (
              <p className="text-sm text-muted">No active jobs.{can('job.create') && <> <Link href="/jobs/new" className="font-medium text-brand-700 underline">Create a job</Link>.</>}</p>
            ) : (
              <ul className="divide-y divide-line">
                {JOB_STATUSES.filter((st) => o.jobCounts![st]).map((st) => (
                  <li key={st}><Link href={`/jobs?status=${st}`} className="flex min-h-11 items-center justify-between text-sm hover:text-brand-700"><span>{JOB_STATUS_LABEL[st as JobStatus]}</span><span className="font-semibold tabular-nums">{o.jobCounts![st]}</span></Link></li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {d.recent && !hide.has('activity') && (
        <Card className="mt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Recent activity</h2>
            <Link href="/audit" className="text-sm font-medium text-brand-600 hover:underline">View all</Link>
          </div>
          {d.recent.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.recent.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm">
                  <span className="font-medium">{e.action}</span>
                  <time className="text-xs text-muted" dateTime={e.createdAt.toISOString()}>{fmt(e.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
