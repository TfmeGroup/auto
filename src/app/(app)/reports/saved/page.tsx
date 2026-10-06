import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { formatDate } from '@/lib/format';
import { listSavedReports } from '@/server/reports/saved';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Saved reports' };
export const dynamic = 'force-dynamic';

export default async function SavedReportsPage() {
  const ctx = await requireBusiness();
  const rows = await listSavedReports(ctx);
  return (
    <>
      <PageHeader title="Saved reports" description="Reports and filtered views people have saved. A shared report runs with your own permissions, so you only ever see what your role allows." />
      {rows.length === 0 ? (
        <EmptyState title="Nothing saved yet">Open any report, set your filters and choose “Save this view”, or build a custom report.</EmptyState>
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/reports/saved/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone={r.kind === 'CUSTOM' ? 'brand' : 'neutral'}>{r.kind === 'CUSTOM' ? 'Custom' : 'Saved view'}</Badge>
                    <span>{r.visibility === 'PRIVATE' ? 'Private' : r.visibility === 'SHARED' ? 'Shared' : 'Business-wide'}</span>
                    <span>by {r.owner}</span><span>updated {formatDate(r.updatedAt, ctx.business.timezone, ctx.business.locale)}</span>
                    {r.activeSchedules > 0 && <span>{r.activeSchedules} schedule{r.activeSchedules === 1 ? '' : 's'}</span>}
                  </p>
                  {r.description && <p className="mt-1 text-sm text-muted">{r.description}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {r.kind === 'CUSTOM' && r.canManage && ctx.permissions.has('report.create_custom') && <Link className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={`/reports/builder?id=${r.id}`}>Edit</Link>}
                  {r.canManage && <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/reports/saved/${r.id}`} confirm="Remove this saved report and switch off its schedules?" />}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
