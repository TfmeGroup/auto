import type { Metadata } from 'next';
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { DocumentSettingsForm } from '@/components/documents/DocumentSettingsForm';
import { StorageMeter } from '@/components/documents/StorageMeter';
import { formatBytes, formatDateTime } from '@/lib/format';
import { canUseFeature } from '@/server/billing/features';
import { listGenerations } from '@/server/documents/generator';
import { listCategories } from '@/server/files/categories';
import { getDocumentSettings } from '@/server/files/settings';
import { getStorageReport } from '@/server/files/usage';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Documents and storage' };
export const dynamic = 'force-dynamic';

export default async function DocumentSettingsPage() {
  const ctx = await requireBusiness();
  if (!ctx.permissions.has('document.view')) return <EmptyState title="You do not have access to documents" />;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const manage = can('document.manage');
  const [settings, usage, cats] = await Promise.all([getDocumentSettings(ctx), getStorageReport(ctx), listCategories(ctx)]);
  const failed = manage ? (await listGenerations(ctx, { status: 'FAILED' })).slice(0, 10) : [];

  return (
    <>
      <PageHeader title="Documents and storage" description="How much space you are using, how long files are kept, and your own document categories." />
      <div className="space-y-4">
        <Card className="space-y-4">
          <StorageMeter report={usage} canBill={can('settings.manage_billing')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">By category</h3>
              <ul className="space-y-1 text-sm">{usage.byCategory.length === 0 ? <li className="text-muted">Nothing stored yet.</li> : usage.byCategory.slice(0, 8).map((c) => <li key={c.key} className="flex justify-between gap-3"><span>{c.label}</span><span className="text-muted">{formatBytes(c.bytes)} · {c.files}</span></li>)}</ul>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">By record type</h3>
              <ul className="space-y-1 text-sm">{usage.byRecordType.length === 0 ? <li className="text-muted">Nothing stored yet.</li> : usage.byRecordType.slice(0, 8).map((c) => <li key={c.key} className="flex justify-between gap-3"><span>{c.label}</span><span className="text-muted">{formatBytes(c.bytes)} · {c.files}</span></li>)}</ul>
            </div>
          </div>
          {usage.largest.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold">Largest files</h3>
              <ul className="space-y-1 text-sm">{usage.largest.map((f) => <li key={f.id} className="flex justify-between gap-3"><a href={`/documents/${f.id}`} className="min-w-0 truncate text-brand-700 hover:underline">{f.name}</a><span className="shrink-0 text-muted">{formatBytes(f.sizeBytes)}</span></li>)}</ul>
            </div>
          )}
          {manage && <ActionButton label="Check that every file is still in storage" variant="secondary" path="/api/v1/files/reconcile" />}
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold">Retention, limits and categories</h2>
          <DocumentSettingsForm
            initial={{ trashRetentionDays: settings.trashRetentionDays, financialRetentionYears: settings.financialRetentionYears, maxUploadMb: settings.maxUploadMb }}
            categories={cats} canManage={manage && ctx.subscription.canWrite} canCustomise={canUseFeature(ctx.subscription, 'advanced_documents')}
            platformMax={settings.platformMaxUploadMb} financialFloor={settings.financialRetentionYears}
          />
        </Card>

        {manage && failed.length > 0 && (
          <Card className="space-y-2">
            <h2 className="text-base font-semibold">Documents that could not be made</h2>
            <Alert tone="warn">These were retried automatically and still failed. The financial record they came from is unaffected.</Alert>
            <ul className="divide-y divide-line text-sm">
              {failed.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{g.kind.replace(/_/g, ' ')} · {formatDateTime(g.createdAt, ctx.business.timezone, ctx.business.locale)}<span className="block text-xs text-muted">{g.lastError}</span></span>
                  {ctx.subscription.canWrite && <ActionButton label="Try again" variant="secondary" path={`/api/v1/documents/generations/${g.id}/retry`} />}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
