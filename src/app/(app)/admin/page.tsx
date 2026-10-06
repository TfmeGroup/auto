import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { Kpi } from '@/components/finance/shared';
import { formatBytes, formatDateTime } from '@/lib/format';
import { getAdminOverview } from '@/server/admin/overview';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Administration' };
export const dynamic = 'force-dynamic';

const SEV = { danger: 'danger', warn: 'warn', info: 'brand' } as const;
const SEV_WORD = { danger: 'Urgent', warn: 'Needs attention', info: 'To do' } as const;

export default async function AdminPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'admin.view');
  const o = await getAdminOverview(ctx);
  const when = (d: Date | string) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  return (
    <>
      <PageHeader title="Administration" description={o.business.name + ' · ' + o.subscription.plan + ' plan'} actions={o.can.settings ? <LinkButton href="/settings/all" variant="secondary">All settings</LinkButton> : undefined} />
      {!o.subscription.canWrite && <div className="mb-4"><Alert tone="warn">This business is read-only until the subscription is active again. Your data is safe.</Alert></div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Plan" value={o.subscription.plan} hint={o.subscription.status === 'TRIALING' && o.subscription.trialDaysRemaining !== null ? 'Free trial: ' + o.subscription.trialDaysRemaining + ' days left' : o.subscription.status.toLowerCase().replace('_', ' ')} />
        <Kpi label="Team members" value={o.usage.members.used + ' of ' + o.usage.members.limit} hint={o.usage.members.invited ? o.usage.members.invited + ' invited' : undefined} />
        <Kpi label="Locations" value={o.usage.locations.used + ' of ' + o.usage.locations.limit} />
        <Kpi label="Storage" value={formatBytes(o.usage.storage.usedBytes)} hint={'of ' + formatBytes(o.usage.storage.limitBytes) + ' (' + pct(o.usage.storage.usedBytes, o.usage.storage.limitBytes) + '%)'} tone={pct(o.usage.storage.usedBytes, o.usage.storage.limitBytes) >= 85 ? 'warn' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-base font-semibold">Needs your attention</h2>
          {o.alerts.length === 0 ? <p className="text-sm text-muted">Nothing needs attention right now.</p> : (
            <ul className="divide-y divide-line">
              {o.alerts.map((a) => (
                <li key={a.key} className="py-2.5">
                  <Link href={a.href} className="block hover:underline">
                    <span className="flex items-center gap-2 text-sm font-medium"><Badge tone={SEV[a.severity]}>{SEV_WORD[a.severity]}</Badge>{a.title}</span>
                    <span className="mt-0.5 block text-sm text-muted">{a.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {o.setup && (
          <Card>
            <h2 className="mb-2 text-base font-semibold">Setup</h2>
            <p className="text-sm">{o.setup.complete} of {o.setup.total} checks complete{o.setup.actionRequired ? ', ' + o.setup.actionRequired + ' need action' : ''}{o.setup.warnings ? ', ' + o.setup.warnings + ' could be better' : ''}.</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={o.setup.total} aria-valuenow={o.setup.complete}><div className="h-full bg-brand-600" style={{ width: pct(o.setup.complete, o.setup.total) + '%' }} /></div>
            <div className="mt-3"><LinkButton href="/admin/setup" variant="secondary">Open the setup check</LinkButton></div>
          </Card>
        )}
        <Card>
          <h2 className="mb-2 text-base font-semibold">Connections</h2>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted">Email sending</dt><dd>{o.integrations.email}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Online customer payments</dt><dd>{o.integrations.onlinePayments}</dd></div>
            {o.integrations.failedMessagesLast7Days !== null && <div className="flex justify-between gap-3"><dt className="text-muted">Messages that failed (7 days)</dt><dd>{o.integrations.failedMessagesLast7Days}</dd></div>}
          </dl>
        </Card>
        <Card>
          <h2 className="mb-2 text-base font-semibold">Data management</h2>
          <ul className="space-y-1 text-sm">
            {o.can.import && <li><Link className="font-medium text-brand-700 hover:underline" href="/admin/import">Import</Link> customers, vehicles, suppliers and parts</li>}
            {o.can.export && <li><Link className="font-medium text-brand-700 hover:underline" href="/admin/export">Export</Link> your data, reports and accounting files</li>}
            {o.can.archive && <li><Link className="font-medium text-brand-700 hover:underline" href="/admin/archive">Archive</Link>: see and restore archived records</li>}
            {o.can.search && <li><Link className="font-medium text-brand-700 hover:underline" href="/admin/search">Search</Link> across records, team and audit events</li>}
            <li><Link className="font-medium text-brand-700 hover:underline" href="/settings/data">Retention</Link>: how long things are kept</li>
          </ul>
        </Card>
        {o.recentActivity && (
          <Card className="lg:col-span-2">
            <div className="mb-2 flex items-center justify-between"><h2 className="text-base font-semibold">Recent audit activity</h2><Link href="/audit" className="text-sm font-medium text-brand-600 hover:underline">Open the audit log</Link></div>
            <ul className="divide-y divide-line text-sm">
              {o.recentActivity.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span><span className="font-medium">{r.action}</span> <span className="text-muted">by {r.user}</span></span><span className="text-xs text-muted">{when(r.createdAt)}</span></li>)}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
