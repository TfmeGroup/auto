import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { listCategories } from '@/server/inventory/categories';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Part categories' };
export const dynamic = 'force-dynamic';

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  const showArchived = sp.archived === '1';
  const cats = await listCategories(ctx, { includeArchived: showArchived });
  const canEdit = ctx.permissions.has('inventory.edit') && ctx.subscription.canWrite;
  const tops = cats.filter((c) => !c.parentId);
  const topActive = cats.filter((c) => !c.parentId && c.status === 'ACTIVE');

  const row = (c: (typeof cats)[number], child: boolean) => (
    <li key={c.id} className={child ? 'ml-5 border-l border-line pl-3' : ''}>
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="min-w-0 text-sm"><Link href={`/inventory/parts?categoryId=${c.id}`} className="font-medium text-brand-700 hover:underline">{c.name}</Link> <span className="text-xs text-muted">{c.partCount} part{c.partCount === 1 ? '' : 's'}</span> {c.status === 'ARCHIVED' && <Badge>archived</Badge>}</span>
        {canEdit && (
          <span className="flex flex-wrap items-center gap-2">
            <details><summary className="min-h-9 cursor-pointer text-sm text-brand-700">Rename</summary><InlineForm endpoint={`/api/v1/inventory/categories/${c.id}`} method="PATCH" submitLabel="Save" resetOnSuccess={false} compact fields={[{ name: 'name', label: 'Name', defaultValue: c.name, required: true }]} /></details>
            <ActionButton label={c.status === 'ACTIVE' ? 'Archive' : 'Restore'} variant="ghost" path={`/api/v1/inventory/categories/${c.id}/archive`} body={{ archived: c.status === 'ACTIVE' }} />
          </span>
        )}
      </div>
    </li>
  );

  return (
    <>
      <PageHeader title="Part categories" description="Group your parts however your workshop thinks about them. Categories are archived, never deleted, so history stays readable." />
      {canEdit && (
        <Card className="mb-4 max-w-2xl">
          <h2 className="mb-2 text-base font-semibold">Add a category</h2>
          <InlineForm endpoint="/api/v1/inventory/categories" submitLabel="Add category" fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'parentId', label: 'Inside', type: 'select', options: [{ value: '', label: 'Top level' }, ...topActive.map((c) => ({ value: c.id, label: c.name }))] },
          ]} />
        </Card>
      )}
      <Card className="max-w-2xl">
        {tops.length === 0 ? <p className="text-sm text-muted">No categories yet. Add one above (for example Brakes, Filters, Fluids), or leave parts uncategorised.</p> : (
          <ul className="divide-y divide-line">{tops.map((t) => <li key={t.id}><ul>{row(t, false)}{cats.filter((c) => c.parentId === t.id).map((c) => row(c, true))}</ul></li>)}</ul>
        )}
        <p className="mt-3 text-xs"><Link href={showArchived ? '/inventory/categories' : '/inventory/categories?archived=1'} className="font-medium text-brand-700 hover:underline">{showArchived ? 'Hide archived' : 'Show archived'}</Link></p>
      </Card>
    </>
  );
}
