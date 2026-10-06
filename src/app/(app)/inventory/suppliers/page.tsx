import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InventoryNav, RecordStatusBadge } from '@/components/inventory/shared';
import { inventoryTabs } from '@/components/inventory/nav';
import { Chips, qs } from '@/components/workshop/layout';
import { listSuppliers } from '@/server/inventory/suppliers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Suppliers' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string };
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';
const CHIPS = [['Active', undefined], ['Inactive', 'INACTIVE'], ['Archived', 'ARCHIVED'], ['All', 'all']] as const;

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  const status = sp.status === 'INACTIVE' || sp.status === 'ARCHIVED' || sp.status === 'all' ? sp.status : undefined;
  const { items, meta } = await listSuppliers(ctx, { q: sp.q, page: sp.page, status: status ?? 'ACTIVE', pageSize: 25 });
  const href = (over: Partial<Search>) => `/inventory/suppliers${qs({ q: sp.q, status: sp.status }, { page: undefined, ...over })}`;
  const canManage = ctx.permissions.has('inventory.manage_suppliers');
  return (
    <>
      <PageHeader title="Suppliers" description="Who you buy parts from." actions={canManage && <LinkButton href="/inventory/suppliers/new">Add supplier</LinkButton>} />
      <InventoryNav tabs={inventoryTabs(ctx)} active="suppliers" />
      <form action="/inventory/suppliers" className="mb-3 grid gap-2 sm:grid-cols-3" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Name, phone, email, account or VAT number" aria-label="Search suppliers" className={`${field} sm:col-span-2`} />
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Search</button>
      </form>
      <div className="mb-4"><Chips items={CHIPS.map(([label, s]) => ({ label, href: href({ status: s }), active: (s ?? '') === (status ?? '') }))} /></div>
      {items.length === 0 ? (
        <EmptyState title={sp.q ? 'No suppliers match' : 'No suppliers yet'} action={!sp.q && canManage ? <LinkButton href="/inventory/suppliers/new">Add a supplier</LinkButton> : undefined}>
          {sp.q ? 'Try different words.' : 'Add your suppliers to link them to parts and place purchase orders.'}
        </EmptyState>
      ) : (
        <>
          <ul className="grid gap-2 md:grid-cols-2">
            {items.map((s) => (
              <li key={s.id}>
                <Link href={`/inventory/suppliers/${s.id}`} className="block rounded-xl border border-line bg-surface p-3 shadow-sm hover:bg-canvas">
                  <div className="flex items-start justify-between gap-2"><p className="min-w-0 truncate font-semibold">{s.name}</p><RecordStatusBadge status={s.status} /></div>
                  <p className="truncate text-sm text-muted">{[s.contactPerson, s.phone, s.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
                  <p className="mt-1 text-xs text-muted">{s.partCount} part{s.partCount === 1 ? '' : 's'}{s.openOrders ? ` · ${s.openOrders} open order${s.openOrders === 1 ? '' : 's'}` : ''}{s.accountNumber ? ` · acc ${s.accountNumber}` : ''}</p>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}
