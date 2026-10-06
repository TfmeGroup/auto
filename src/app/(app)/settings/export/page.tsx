import type { Metadata } from 'next';
import { Badge, Card, PageHeader } from '@/components/ui';
import { AutoRefresh, RequestExport } from '@/components/forms/ExportControls';
import { exportableDatasets, listExports } from '@/server/exports/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatBytes, formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Data export' };
export const dynamic = 'force-dynamic';

const TONE = { PENDING: 'neutral', PROCESSING: 'brand', READY: 'ok', FAILED: 'danger', EXPIRED: 'neutral' } as const;

export default async function ExportPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'business.export');
  const [{ items }, datasets] = await Promise.all([listExports(ctx, { pageSize: 20 }), Promise.resolve(exportableDatasets(ctx))]);
  const when = (d: Date | string) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);
  const reason = ctx.subscription.features.has('data_export') ? null : 'Data export is not included in your plan.';

  return (
    <>
      <PageHeader title="Data export" description="Take a copy of your business data. Exports are prepared in the background, kept private, and expire after a few days." />
      <AutoRefresh active={items.some((i) => i.status === 'PENDING' || i.status === 'PROCESSING')} />
      <Card className="mb-4"><RequestExport datasets={datasets.map((d) => ({ key: d.key, label: d.label }))} disabledReason={reason} /></Card>
      <Card>
        <h2 className="mb-2 text-base font-semibold">Your exports</h2>
        {items.length === 0 ? <p className="text-sm text-muted">No exports yet.</p> : (
          <ul className="divide-y divide-line">
            {items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-medium">{when(x.requestedAt)}</p>
                  <p className="text-xs text-muted">{x.scope.join(', ')}{x.sizeBytes ? ` · ${formatBytes(x.sizeBytes)}` : ''}{x.expiresAt && x.status === 'READY' ? ` · expires ${when(x.expiresAt)}` : ''}</p>
                  {x.error && <p className="text-xs text-danger">{x.error}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={TONE[x.status]}>{x.status.toLowerCase()}</Badge>
                  {x.status === 'READY' && <a href={`/api/v1/exports/${x.id}/download`} className="inline-flex min-h-11 items-center font-medium text-brand-600 hover:underline">Download</a>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
