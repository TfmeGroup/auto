import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { RetentionForm } from '@/components/settings/ConfigForms';
import { getRetention } from '@/server/settings/config-service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Data and retention' };
export const dynamic = 'force-dynamic';

export default async function DataSettingsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const r = await getRetention(ctx);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  return (
    <>
      <PageHeader title="Data and retention" description="Bring data in, take it out, and decide how long working data is kept." />
      <div className="space-y-4">
        <Card>
          <h2 className="mb-2 text-base font-semibold">Import and export</h2>
          <ul className="space-y-1 text-sm">
            {can('data.import') && <li><Link className="font-medium text-brand-700 hover:underline" href="/admin/import">Import centre</Link>: customers, vehicles, suppliers and parts from a spreadsheet, checked before anything is saved.</li>}
            {can('business.export') && <li><Link className="font-medium text-brand-700 hover:underline" href="/admin/export">Export centre</Link>: a full copy of your business data, reports and accounting files.</li>}
            {!can('data.import') && !can('business.export') && <li className="text-muted">Your role cannot import or export data.</li>}
          </ul>
        </Card>
        <Card>
          <h2 className="mb-3 text-base font-semibold">Retention</h2>
          <RetentionForm initial={r} canEdit={can('settings.edit') && can('document.manage') && ctx.subscription.canWrite} />
        </Card>
      </div>
    </>
  );
}
