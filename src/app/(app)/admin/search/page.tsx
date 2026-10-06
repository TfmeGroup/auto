import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { adminSearch } from '@/server/admin/search';
import { canUseFeature } from '@/server/billing/features';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Administration search' };
export const dynamic = 'force-dynamic';

export default async function AdminSearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'admin.view');
  if (!canUseFeature(ctx.subscription, 'advanced_admin')) return (<><PageHeader title="Search" /><EmptyState title="Not included in your plan">Administration search is part of the Business plan. The search box at the top still finds customers, vehicles, jobs and more.</EmptyState></>);
  const { q } = await searchParams;
  let groups: Awaited<ReturnType<typeof adminSearch>> = [];
  let problem: string | null = null;
  if (q) { try { groups = await adminSearch(ctx, { q, limit: 8 }); } catch (e) { problem = e instanceof AppError ? e.message : 'The search could not run.'; } }
  return (
    <>
      <PageHeader title="Search everything" description="Customers, vehicles, jobs, quotes, invoices, payments, parts, suppliers, team members, documents and audit events. Ordinary text matching on names, numbers and references." />
      <form method="get" role="search" className="mb-4 flex gap-2"><input name="q" defaultValue={q} aria-label="Search" placeholder="A name, number, registration, reference…" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 sm:flex-1 md:min-h-10" /><button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Search</button></form>
      {problem && <p role="alert" className="mb-3 text-sm text-danger">{problem}</p>}
      {q && !problem && groups.length === 0 && <EmptyState title={'Nothing found for “' + q + '”'}>Try fewer or different words. You only see results you are allowed to open.</EmptyState>}
      <div className="space-y-4">
        {groups.map((g) => (
          <Card key={g.key}>
            <h2 className="mb-2 text-base font-semibold">{g.label}</h2>
            <ul className="divide-y divide-line">{g.items.map((i) => <li key={i.id}><Link href={i.href} className="block py-2.5 hover:underline"><span className="font-medium">{i.title}</span>{i.subtitle && <span className="block text-sm text-muted">{i.subtitle}</span>}</Link></li>)}</ul>
          </Card>
        ))}
      </div>
    </>
  );
}
