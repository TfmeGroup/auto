import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, Pagination } from '@/components/ui';
import { DocumentUploader } from '@/components/documents/DocumentUploader';
import { DocRow } from '@/components/documents/shared';
import { StorageMeter } from '@/components/documents/StorageMeter';
import { recordHref } from '@/components/documents/record-links';
import { isAppError } from '@/lib/errors';
import { listCategories } from '@/server/files/categories';
import { RESOURCES } from '@/server/files/registry';
import { searchDocuments } from '@/server/files/search';
import { getDocumentSettings } from '@/server/files/settings';
import { getStorageReport } from '@/server/files/usage';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const control = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm md:min-h-10';

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requireBusiness();
  if (!ctx.permissions.has('document.view')) {
    return <EmptyState title="You do not have access to documents">Ask an owner or manager if you need it.</EmptyState>;
  }
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const query = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]).filter(([, v]) => v !== ''));
  let result;
  let problem: string | null = null;
  try {
    result = await searchDocuments(ctx, { pageSize: 20, ...query });
  } catch (e) {
    if (isAppError(e) && (e.code === 'VALIDATION_ERROR' || e.code === 'FORBIDDEN')) problem = e.message;
    else throw e;
  }
  const [cats, usage, settings] = await Promise.all([listCategories(ctx), getStorageReport(ctx), getDocumentSettings(ctx)]);
  const state = one(sp.state) || 'active';
  const base = new URLSearchParams(Object.entries(query).filter(([k]) => k !== 'page') as [string, string][]);
  const href = (extra: Record<string, string>) => {
    const p = new URLSearchParams(base);
    for (const [k, v] of Object.entries(extra)) { if (v) p.set(k, v); else p.delete(k); }
    return `/documents?${p.toString()}`;
  };
  const tabs: [string, string][] = [['active', 'Active'], ['archived', 'Archived'], ...(can('document.delete') ? ([['trash', 'Trash']] as [string, string][]) : [])];

  return (
    <>
      <PageHeader title="Documents" description="Every file and photo in one place: search across customers, vehicles, jobs, quotes, invoices, suppliers and more." />
      <Card className="mb-4"><StorageMeter report={usage} canBill={can('settings.manage_billing')} /></Card>

      {can('document.manage') && ctx.subscription.canWrite && (
        <Card className="mb-4 space-y-2">
          <h2 className="text-base font-semibold">Business documents</h2>
          <p className="text-xs text-muted">Files that belong to the business itself (licences, policies, price lists). To attach something to a customer, vehicle or job, open that record.</p>
          <DocumentUploader resourceType="business" resourceId={ctx.business.id} categories={cats.filter((c) => c.active).map((c) => ({ key: c.key, label: c.label }))} defaultCategory="OTHER" canShare={false} canRestrict={can('document.view_restricted')} maxMb={settings.effectiveMaxUploadMb} />
        </Card>
      )}

      <nav aria-label="Document state" className="mb-3 flex gap-1 border-b border-line">
        {tabs.map(([k, label]) => (
          <Link key={k} href={href({ state: k, page: '' })} aria-current={state === k ? 'page' : undefined} className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${state === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink'}`}>{label}</Link>
        ))}
      </nav>

      <form method="get" className="mb-4 grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4">
        <input type="hidden" name="state" value={state} />
        {sp.resourceType && <input type="hidden" name="resourceType" value={one(sp.resourceType)} />}
        {sp.resourceId && <input type="hidden" name="resourceId" value={one(sp.resourceId)} />}
        <div className="sm:col-span-2"><label htmlFor="q" className="mb-1 block text-xs font-medium">Search</label><input id="q" name="q" defaultValue={one(sp.q)} className={control} placeholder="Name, customer, registration, VIN, job, quote or invoice number…" maxLength={100} /></div>
        <div><label htmlFor="category" className="mb-1 block text-xs font-medium">Category</label><select id="category" name="category" defaultValue={one(sp.category)} className={control}><option value="">All</option>{cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
        <div><label htmlFor="fileType" className="mb-1 block text-xs font-medium">File type</label><select id="fileType" name="fileType" defaultValue={one(sp.fileType)} className={control}><option value="">All</option><option value="image">Photos</option><option value="pdf">PDF</option><option value="spreadsheet">Spreadsheets</option><option value="document">Documents</option></select></div>
        <div><label htmlFor="visibility" className="mb-1 block text-xs font-medium">Who can see it</label><select id="visibility" name="visibility" defaultValue={one(sp.visibility)} className={control}><option value="">Any</option><option value="INTERNAL">Staff only</option><option value="CUSTOMER">Customer can see</option>{can('document.view_restricted') && <option value="RESTRICTED">Restricted</option>}</select></div>
        <div><label htmlFor="from" className="mb-1 block text-xs font-medium">From</label><input id="from" name="from" type="date" defaultValue={one(sp.from)} className={control} /></div>
        <div><label htmlFor="to" className="mb-1 block text-xs font-medium">To</label><input id="to" name="to" type="date" defaultValue={one(sp.to)} className={control} /></div>
        <div><label htmlFor="sort" className="mb-1 block text-xs font-medium">Sort</label><select id="sort" name="sort" defaultValue={one(sp.sort) || 'newest'} className={control}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name</option><option value="size">Largest first</option></select></div>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          <button className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 md:min-h-10">Search</button>
          <Link href={`/documents?state=${state}`} className="inline-flex min-h-11 items-center px-3 text-sm text-brand-600 hover:underline md:min-h-10">Clear</Link>
        </div>
      </form>

      {problem && <p className="mb-3 text-sm font-medium text-danger" role="alert">{problem}</p>}
      {result && result.items.length === 0 ? (
        <EmptyState title={state === 'trash' ? 'The trash is empty' : state === 'archived' ? 'Nothing is archived' : Object.keys(query).some((k) => !['state', 'page', 'sort'].includes(k)) ? 'Nothing matches that search' : 'No documents yet'}>
          {state === 'active' && !Object.keys(query).some((k) => !['state', 'page', 'sort'].includes(k)) ? 'Open a customer, vehicle, job or supplier and upload a file or take a photo, and it will appear here.' : 'Try a different search or clear the filters.'}
        </EmptyState>
      ) : result ? (
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-line px-4">
            {result.items.map((f) => (
              <DocRow key={f.id} f={f} locale={ctx.business.locale} tz={ctx.business.timezone}>
                {f.resourceType && f.resourceId && recordHref(f.resourceType, f.resourceId) && (
                  <p className="mt-1 text-xs text-muted">On <Link href={recordHref(f.resourceType, f.resourceId)!} className="text-brand-700 hover:underline">{RESOURCES[f.resourceType]?.label ?? f.resourceType}</Link></p>
                )}
              </DocRow>
            ))}
          </ul>
        </Card>
      ) : null}
      {result && <Pagination page={result.meta.page} totalPages={result.meta.totalPages} total={result.meta.total} hrefFor={(p) => href({ page: String(p) })} />}
    </>
  );
}
