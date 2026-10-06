import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { availableReports } from '@/server/reports/run';
import { listSavedReports } from '@/server/reports/saved';
import { CATEGORY_LABEL, type ReportCategory } from '@/server/reports/types';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

const ORDER: ReportCategory[] = ['financial', 'jobs', 'bookings', 'customers', 'vehicles', 'technicians', 'inventory', 'suppliers', 'profitability', 'vat'];

export default async function ReportsPage() {
  const ctx = await requireBusiness();
  const reports = availableReports(ctx);
  const saved = (await listSavedReports(ctx)).slice(0, 6);
  const by = ORDER.map((c) => ({ key: c, label: CATEGORY_LABEL[c], items: reports.filter((r) => r.category === c) })).filter((g) => g.items.length > 0);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);

  return (
    <>
      <PageHeader title="Reports" description="Every figure is worked out from your real records when you open the report. You only see the reports and columns your role allows." />
      {by.length === 0 ? (
        <EmptyState title="No reports are available to your role">Ask an owner or admin for access to the reports you need.</EmptyState>
      ) : (
        <div className="space-y-6">
          {saved.length > 0 && (
            <section aria-labelledby="saved-h">
              <div className="mb-2 flex items-center justify-between"><h2 id="saved-h" className="text-base font-semibold">Saved reports</h2><Link href="/reports/saved" className="text-sm font-medium text-brand-600 hover:underline">All saved</Link></div>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {saved.map((s) => (
                  <li key={s.id}><Link href={`/reports/saved/${s.id}`} className="block rounded-xl border border-line bg-surface p-3.5 hover:border-brand-500"><p className="font-medium">{s.name}</p><p className="mt-0.5 text-xs text-muted">{s.kind === 'CUSTOM' ? 'Custom report' : 'Saved view'} · {s.visibility.toLowerCase()} · by {s.owner}</p></Link></li>
                ))}
              </ul>
            </section>
          )}
          {by.map((g) => (
            <section key={g.key} aria-labelledby={`h-${g.key}`}>
              <h2 id={`h-${g.key}`} className="mb-2 text-base font-semibold">{g.label}</h2>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((r) => (
                  <li key={r.key}>
                    <Link href={`/reports/${r.key}`} className="flex h-full flex-col rounded-xl border border-line bg-surface p-3.5 hover:border-brand-500">
                      <span className="flex items-start justify-between gap-2"><span className="font-medium">{r.title}</span>{r.locked && <Badge tone="warn">Upgrade</Badge>}</span>
                      <span className="mt-1 text-sm text-muted">{r.description}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <Card>
            <h2 className="text-base font-semibold">More</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {can('report.create_custom') && <li><Link className="font-medium text-brand-700 hover:underline" href="/reports/builder">Build a custom report</Link> from the approved fields of your records.</li>}
              {can('report.manage_scheduled') && <li><Link className="font-medium text-brand-700 hover:underline" href="/reports/schedules">Schedule a report</Link> to be emailed daily, weekly or monthly.</li>}
              {can('business.export') && <li><Link className="font-medium text-brand-700 hover:underline" href="/admin/export">Export centre</Link> for full data exports and accounting files.</li>}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
