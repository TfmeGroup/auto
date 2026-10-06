import type { Metadata } from 'next';
import { Card, EmptyState, PageHeader, Pagination } from '@/components/ui';
import { qs } from '@/components/workshop/layout';
import { AppError } from '@/lib/errors';
import { searchAuditLog } from '@/server/admin/audit';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDateTime } from '@/lib/format';
import { withTenant } from '@/server/db/client';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

type SP = { page?: string; action?: string; q?: string; userId?: string; from?: string; to?: string; resourceType?: string };
const field = 'mt-1 block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'audit.view');
  const sp = await searchParams;
  let result: Awaited<ReturnType<typeof searchAuditLog>> | null = null;
  let problem: string | null = null;
  try { result = await searchAuditLog(ctx, { ...sp, pageSize: 50 }); } catch (e) { problem = e instanceof AppError ? e.message : 'The audit log could not be read.'; }
  const people = await withTenant(ctx.business.id, async (tx) => (await tx.membership.findMany({ where: { businessId: ctx.business.id, userId: { not: null } }, select: { user: { select: { id: true, name: true } } } })).flatMap((m) => (m.user ? [m.user] : [])));
  const when = (d: Date) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);
  const base = { action: sp.action, q: sp.q, userId: sp.userId, from: sp.from, to: sp.to, resourceType: sp.resourceType };
  const canExport = ctx.permissions.has('business.export') && ctx.subscription.features.has('data_export');

  return (
    <>
      <PageHeader title="Audit log" description="A permanent record of important actions in your business. It cannot be edited or deleted by anyone." actions={canExport ? <a className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={'/api/v1/admin/audit/export' + qs(base)}>Export CSV</a> : undefined} />
      <Card className="mb-4">
        <form action="/audit" role="search" aria-label="Filter the audit log" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm font-medium">Search<input name="q" defaultValue={sp.q} placeholder="Action, record or person" className={field} /></label>
          <label className="text-sm font-medium">Action starts with<input name="action" defaultValue={sp.action} placeholder="e.g. customer, invoice, member" className={field} /></label>
          <label className="text-sm font-medium">Person<select name="userId" defaultValue={sp.userId ?? ''} className={field}><option value="">Anyone</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="text-sm font-medium">Record type<input name="resourceType" defaultValue={sp.resourceType} placeholder="e.g. invoice, job" className={field} /></label>
          <label className="text-sm font-medium">From<input type="date" name="from" defaultValue={sp.from} className={field} /></label>
          <label className="text-sm font-medium">To<input type="date" name="to" defaultValue={sp.to} className={field} /></label>
          <div className="flex items-end gap-2 sm:col-span-2"><button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Filter</button><a href="/audit" className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-brand-600 md:min-h-10">Reset</a></div>
        </form>
      </Card>
      {problem && <p role="alert" className="mb-3 text-sm text-danger">{problem}</p>}
      {result && (result.items.length === 0 ? <EmptyState title="No matching activity" /> : (
        <>
          <ul className="grid gap-2 md:hidden">
            {result.items.map((e) => <li key={e.id}><Card><p className="font-medium">{e.action}</p><p className="text-sm text-muted">{e.user}</p><p className="text-xs text-muted">{when(e.createdAt)}</p></Card></li>)}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">Audit log</caption>
              <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted"><tr><th scope="col" className="px-4 py-2.5 font-medium">When</th><th scope="col" className="px-4 py-2.5 font-medium">Who</th><th scope="col" className="px-4 py-2.5 font-medium">Action</th><th scope="col" className="px-4 py-2.5 font-medium">Record</th></tr></thead>
              <tbody className="divide-y divide-line">
                {result.items.map((e) => <tr key={e.id}><td className="whitespace-nowrap px-4 py-2.5 text-muted">{when(e.createdAt)}</td><td className="px-4 py-2.5">{e.user}</td><td className="px-4 py-2.5 font-medium">{e.action}</td><td className="px-4 py-2.5 text-muted">{e.resourceType ?? '—'}</td></tr>)}
              </tbody>
            </table>
          </div>
          <Pagination page={result.meta.page} totalPages={result.meta.totalPages} total={result.meta.total} hrefFor={(p) => '/audit' + qs(base, { page: String(p) })} />
        </>
      ))}
    </>
  );
}
