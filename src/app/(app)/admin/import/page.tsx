import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, PageHeader } from '@/components/ui';
import { ImportWizard } from '@/components/admin/ImportWizard';
import { formatDateTime } from '@/lib/format';
import { availableKinds, listImports } from '@/server/imports/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Import' };
export const dynamic = 'force-dynamic';

const TONE = { DONE: 'ok', FAILED: 'danger', CANCELLED: 'neutral', PROCESSING: 'brand', VALIDATED: 'warn', UPLOADED: 'neutral' } as const;

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'data.import');
  const sp = await searchParams;
  const [kinds, history] = [availableKinds(ctx), await listImports(ctx)];
  const parts = ctx.permissions.has('inventory.import') && ctx.subscription.features.has('bulk_inventory');
  return (
    <>
      <PageHeader title="Import data" description="Bring customers, vehicles, suppliers and parts in from a spreadsheet. Every row is checked first, duplicates are never merged, and nothing is saved until you confirm." />
      <div className="space-y-4">
        <ImportWizard kinds={kinds} initialKind={sp.kind} />
        {parts && <Card><p className="text-sm"><strong>Parts</strong> have their own importer, with prices, categories and opening stock: <Link className="font-medium text-brand-700 hover:underline" href="/inventory/import">open the parts importer</Link>.</p></Card>}
        <Card>
          <h2 className="mb-2 text-base font-semibold">Recent imports</h2>
          {history.length === 0 ? <p className="text-sm text-muted">No imports yet.</p> : (
            <ul className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span><Link className="font-medium text-brand-700 hover:underline" href={'/admin/import/' + h.id}>{h.fileName}</Link> <span className="text-muted">· {h.kind} · {formatDateTime(h.createdAt, ctx.business.timezone, ctx.business.locale)}</span></span>
                  <span className="flex items-center gap-2"><Badge tone={TONE[h.status as keyof typeof TONE] ?? 'neutral'}>{h.status.toLowerCase()}</Badge><span className="text-xs text-muted">{h.importedRows} imported of {h.totalRows}</span></span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Staged files are cleared after your import retention period (Settings, Data). The records they created stay.</p>
        </Card>
      </div>
    </>
  );
}
