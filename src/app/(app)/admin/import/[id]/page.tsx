import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, PageHeader, Pagination } from '@/components/ui';
import { qs } from '@/components/workshop/layout';
import { getImport } from '@/server/imports/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Import result' };
export const dynamic = 'force-dynamic';

export default async function ImportResultPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; page?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'data.import');
  const { id } = await params;
  const sp = await searchParams;
  const b = await getImport(ctx, id, { status: sp.status || undefined, page: Number(sp.page) || 1 });
  const tabs = [['', 'Not imported'], ['IMPORTED', 'Imported'], ['SKIPPED', 'Skipped'], ['DUPLICATE', 'Duplicates'], ['FAILED', 'Failed']];
  return (
    <>
      <PageHeader title={b.fileName} description={b.kind + ' import · ' + b.status.toLowerCase()} actions={<Link className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={'/api/v1/imports/' + b.id + '/problems'}>Download rows to fix</Link>} />
      <p className="mb-3 text-sm">{b.totalRows} rows · <strong>{b.importedRows}</strong> imported · {b.skippedRows} skipped · {b.duplicateRows} duplicates · {b.failedRows} failed</p>
      <nav aria-label="Rows" className="-mx-3 mb-3 flex gap-1 overflow-x-auto px-3 sm:mx-0 sm:px-0">{tabs.map(([k, l]) => <Link key={k} href={'/admin/import/' + b.id + qs({ status: k })} aria-current={(sp.status ?? '') === k ? 'page' : undefined} className={'inline-flex min-h-11 shrink-0 items-center rounded-lg border px-3 text-sm font-medium ' + ((sp.status ?? '') === k ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line')}>{l}</Link>)}</nav>
      {b.rows.length === 0 ? <p className="text-sm text-muted">No rows in this view.</p> : (
        <ul className="grid gap-2">
          {b.rows.map((r) => (
            <li key={r.row}>
              <Card>
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">Row {r.row} <Badge tone={r.status === 'IMPORTED' ? 'ok' : r.status === 'DUPLICATE' || r.status === 'SKIPPED' ? 'warn' : 'danger'}>{r.status.toLowerCase()}</Badge></p>
                <p className="mt-0.5 text-sm text-muted">{r.status === 'DUPLICATE' ? r.duplicateOf : r.errors.join(' ') || Object.values(r.raw).filter(Boolean).slice(0, 4).join(' · ')}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={b.meta.page} totalPages={b.meta.totalPages} total={b.meta.total} hrefFor={(p) => '/admin/import/' + b.id + qs({ status: sp.status, page: String(p) })} />
    </>
  );
}
