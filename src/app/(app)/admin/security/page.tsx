import type { Metadata } from 'next';
import { Badge, Card, EmptyState, PageHeader, Pagination } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { listSecurityEvents, memberSignInStatus } from '@/server/admin/audit';
import { canUseFeature } from '@/server/billing/features';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Security events' };
export const dynamic = 'force-dynamic';

export default async function SecurityEventsPage({ searchParams }: { searchParams: Promise<{ page?: string; action?: string; from?: string; to?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'security.view_events');
  if (!canUseFeature(ctx.subscription, 'advanced_admin')) return (<><PageHeader title="Security events" /><EmptyState title="Not included in your plan">Security events are part of the Business plan.</EmptyState></>);
  const sp = await searchParams;
  const [events, members] = [await listSecurityEvents(ctx, { page: sp.page, action: sp.action, from: sp.from, to: sp.to, pageSize: 25 }), await memberSignInStatus(ctx)];
  const when = (d: Date | string) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);
  return (
    <>
      <PageHeader title="Security events" description="Changes to people, roles, ownership and security settings, and data leaving the business. Details like addresses and devices are not shown." />
      <div className="space-y-4">
        <Card>
          <h2 className="mb-2 text-base font-semibold">Sign-in protection</h2>
          <p className="mb-2 text-xs text-muted">Each person&apos;s own sign-in history is private to their account. This shows whether your people are protected.</p>
          <ul className="divide-y divide-line">
            {members.map((m) => (
              <li key={m.membershipId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span><span className="font-medium">{m.name}</span> <span className="text-muted">· {m.role}{m.status === 'SUSPENDED' ? ' · suspended' : ''}</span></span>
                <span className="flex flex-wrap items-center gap-2"><Badge tone={m.mfaEnabled ? 'ok' : 'warn'}>{m.mfaEnabled ? 'Two-factor on' : 'Two-factor off'}</Badge><span className="text-xs text-muted">{m.lastActiveAt ? 'active ' + when(m.lastActiveAt) : 'not signed in'} · {m.signedInDevices} device{m.signedInDevices === 1 ? '' : 's'}</span></span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="mb-2 text-base font-semibold">Events</h2>
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2" role="search">
            <label className="text-sm">From<input type="date" name="from" defaultValue={sp.from} className="mt-1 block min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10" /></label>
            <label className="text-sm">To<input type="date" name="to" defaultValue={sp.to} className="mt-1 block min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10" /></label>
            <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Filter</button>
          </form>
          {events.items.length === 0 ? <p className="text-sm text-muted">No events match.</p> : (
            <ul className="divide-y divide-line">
              {events.items.map((e) => (
                <li key={e.id} className="py-2.5 text-sm">
                  <p className="flex flex-wrap items-center justify-between gap-2"><span><span className="font-medium">{e.action}</span> <span className="text-muted">by {e.user}</span></span><span className="text-xs text-muted">{when(e.createdAt)}</span></p>
                  {Object.keys(e.details).length > 0 && <p className="text-xs text-muted">{Object.entries(e.details).map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : String(v))).join(' · ')}</p>}
                </li>
              ))}
            </ul>
          )}
          <Pagination page={events.meta.page} totalPages={events.meta.totalPages} total={events.meta.total} hrefFor={(p) => '/admin/security?page=' + p + (sp.from ? '&from=' + sp.from : '') + (sp.to ? '&to=' + sp.to : '')} />
        </Card>
      </div>
    </>
  );
}
