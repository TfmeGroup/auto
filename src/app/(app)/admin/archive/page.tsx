import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, Pagination } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { Tabs, qs } from '@/components/workshop/layout';
import { archiveKinds, listArchived } from '@/server/admin/archive';
import { canUseFeature } from '@/server/billing/features';
import { formatDate } from '@/lib/format';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Archive' };
export const dynamic = 'force-dynamic';

export default async function ArchivePage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string; page?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'admin.view');
  if (!canUseFeature(ctx.subscription, 'advanced_admin')) return (<><PageHeader title="Archive" /><EmptyState title="Not included in your plan">Archive management is part of the Business plan. You can still restore records from their own lists.</EmptyState></>);
  const kinds = archiveKinds(ctx);
  const sp = await searchParams;
  if (kinds.length === 0) return (<><PageHeader title="Archive" /><EmptyState title="Nothing you can restore">Your role cannot restore archived records.</EmptyState></>);
  const kind = kinds.some((k) => k.key === sp.kind) ? sp.kind! : kinds[0]!.key;
  const r = await listArchived(ctx, kind, { q: sp.q, page: sp.page, pageSize: 25 });
  return (
    <>
      <PageHeader title="Archive" description="Records that were archived. Restoring one brings it back with its full history, using the same checks as restoring it from its own page." />
      <Tabs tabs={kinds.map((k) => ({ key: k.key, label: k.label }))} active={kind} hrefFor={(k) => '/admin/archive' + qs({ kind: k })} />
      <form method="get" action="/admin/archive" role="search" className="mb-3 flex gap-2"><input type="hidden" name="kind" value={kind} /><input name="q" defaultValue={sp.q} placeholder="Search archived records" aria-label="Search archived records" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 sm:flex-1 md:min-h-10" /><button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Search</button></form>
      {r.items.length === 0 ? <EmptyState title="Nothing archived here" /> : (
        <ul className="grid gap-2">
          {r.items.map((i) => (
            <li key={i.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0"><p className="font-medium">{i.href ? <Link className="text-brand-700 hover:underline" href={i.href}>{i.title}</Link> : i.title}</p><p className="text-xs text-muted">{[i.subtitle, i.archivedAt ? 'archived ' + formatDate(i.archivedAt, ctx.business.timezone, ctx.business.locale) : null].filter(Boolean).join(' · ')}</p></div>
                {ctx.subscription.canWrite && <ActionButton label="Restore" path={'/api/v1/admin/archive/' + kind + '/' + i.id + '/restore'} confirm="Restore this record?" />}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={r.meta.page} totalPages={r.meta.totalPages} total={r.meta.total} hrefFor={(p) => '/admin/archive' + qs({ kind, q: sp.q, page: String(p) })} />
    </>
  );
}
